/**
 * verifyDriverSession — authenticated, side-effect-free secure session check.
 *
 * Cold-start revalidation for WB-S (and any secure field app). Identity
 * comes only from request.auth; request body must be empty.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import { driverAuthUid } from './tokenMint';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
  type CanonicalDriverRecordReaders,
} from './canonicalDriverAuthority';

export const VERIFY_DRIVER_SESSION_OPTIONS = {
  timeoutSeconds: 15,
  memory: '256MiB' as const,
  enforceAppCheck: false,
};

/** Exact success body — three keys only. */
export type VerifyDriverSessionSuccess = {
  driverId: string;
  companyId: string;
  active: true;
};

export type VerifyDriverSessionFailure = {
  code: 'unauthenticated' | 'permission-denied' | 'invalid-argument';
  /** Coarse public message — never enumerates which field failed. */
  message: string;
};

export type VerifyDriverSessionResult =
  | { ok: true; value: VerifyDriverSessionSuccess }
  | { ok: false; error: VerifyDriverSessionFailure };

/**
 * Pure decision core (unit-testable without Firebase).
 *
 * No logging of tokens, passcodes, hashes, or raw auth material.
 */
export async function evaluateVerifyDriverSession(input: {
  uid: string | null | undefined;
  claims: Record<string, unknown> | null | undefined;
  data: unknown;
  readers: CanonicalDriverRecordReaders;
  resolveAuthUid?: (driverId: string) => string;
}): Promise<VerifyDriverSessionResult> {
  const resolveUid = input.resolveAuthUid ?? driverAuthUid;

  // ── request shape: reject every key ──────────────────────────────────
  if (input.data != null) {
    if (typeof input.data !== 'object' || Array.isArray(input.data)) {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: 'invalid_request' },
      };
    }
    if (Object.keys(input.data as object).length > 0) {
      return {
        ok: false,
        error: { code: 'invalid-argument', message: 'invalid_request' },
      };
    }
  }

  // ── authentication ───────────────────────────────────────────────────
  const uid = input.uid;
  if (!uid || typeof uid !== 'string') {
    return {
      ok: false,
      error: { code: 'unauthenticated', message: 'unauthenticated' },
    };
  }

  const claims = input.claims || {};
  if (claims.kind !== 'driver') {
    return {
      ok: false,
      error: { code: 'permission-denied', message: 'not_authorized' },
    };
  }

  const claimDriverId =
    typeof claims.driverId === 'string' ? claims.driverId.trim() : '';
  if (!claimDriverId) {
    return {
      ok: false,
      error: { code: 'permission-denied', message: 'not_authorized' },
    };
  }

  const claimCompanyId =
    typeof claims.companyId === 'string' ? claims.companyId.trim() : '';
  if (!claimCompanyId) {
    return {
      ok: false,
      error: { code: 'permission-denied', message: 'not_authorized' },
    };
  }

  // ── UID must be the deterministic Auth uid for this driver ───────────
  if (uid !== resolveUid(claimDriverId)) {
    return {
      ok: false,
      error: { code: 'permission-denied', message: 'not_authorized' },
    };
  }

  // ── canonical server records (shared with SSO) ───────────────────────
  const authority = await loadCanonicalDriverAuthority(claimDriverId, input.readers);
  if (!authority || !authority.active) {
    return {
      ok: false,
      error: { code: 'permission-denied', message: 'not_authorized' },
    };
  }

  if (authority.companyId !== claimCompanyId) {
    return {
      ok: false,
      error: { code: 'permission-denied', message: 'not_authorized' },
    };
  }
  const claimGeneration = typeof claims.credentialGeneration === 'number'
    ? claims.credentialGeneration : 0;
  if (claimGeneration !== authority.credentialGeneration) {
    return { ok: false, error: { code: 'permission-denied', message: 'not_authorized' } };
  }

  // Client cannot select another driver or company — identity is only claims.
  return {
    ok: true,
    value: {
      driverId: authority.driverId,
      companyId: authority.companyId,
      active: true,
    },
  };
}

export const verifyDriverSession = httpsV2.onCall(
  VERIFY_DRIVER_SESSION_OPTIONS,
  async (request) => {
    const result = await evaluateVerifyDriverSession({
      uid: request.auth?.uid,
      claims: (request.auth?.token || {}) as unknown as Record<string, unknown>,
      data: request.data,
      readers: productionCanonicalDriverReaders(),
    });

    if (!result.ok) {
      // Coarse only — no internal reason in the client payload.
      throw new httpsV2.HttpsError(result.error.code, result.error.message);
    }

    // Exact three-key success body.
    return {
      driverId: result.value.driverId,
      companyId: result.value.companyId,
      active: true as const,
    };
  },
);
