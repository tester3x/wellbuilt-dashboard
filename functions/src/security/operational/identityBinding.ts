import { createHash } from 'crypto';

/**
 * Server-controlled one-to-one binding:
 *   canonical UUID  ↔  exact legacy approved key
 *
 * Both directions are one atomic record pair. One-sided state is incomplete
 * (repair or refuse) — never already_exact. Bindings live under Admin-only
 * RTDB paths, never on a client-readable profile.
 */
export const APPROVED_KEY_RE = /^[A-Za-z0-9_-]{16,}$/;
export const DRIVER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BindingStatus = 'active' | 'legacy_login_retired';

export interface IdentityBinding {
  driverId: string;
  approvedKey: string;
  status: BindingStatus;
  opId: string;
}

export function parseBinding(raw: unknown): IdentityBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.driverId !== 'string' || !DRIVER_UUID_RE.test(o.driverId)) return null;
  if (typeof o.approvedKey !== 'string' || !APPROVED_KEY_RE.test(o.approvedKey)) return null;
  if (o.status !== 'active' && o.status !== 'legacy_login_retired') return null;
  return {
    driverId: o.driverId,
    approvedKey: o.approvedKey,
    status: o.status,
    opId: typeof o.opId === 'string' ? o.opId : '',
  };
}

export function bindingsAgree(a: IdentityBinding | null, b: IdentityBinding | null): boolean {
  if (!a || !b) return false;
  return a.driverId === b.driverId
    && a.approvedKey === b.approvedKey
    && a.status === b.status
    && a.opId === b.opId;
}

export type BindDecision =
  | { action: 'write'; payload: IdentityBinding }
  | { action: 'repair'; payload: IdentityBinding }
  | { action: 'already_exact' }
  | { action: 'refuse'; reason: string };

function pairMatches(b: IdentityBinding, driverId: string, approvedKey: string): boolean {
  return b.driverId === driverId && b.approvedKey === approvedKey;
}

/**
 * 1:1 uniqueness. already_exact only when BOTH records exist and agree on
 * UUID, approved key, status, and opId. One-sided state is repair (same pair)
 * or refuse (foreign pair). Concurrent cross-bind is refuse.
 */
export function decideBindIdentity(input: {
  driverId: string;
  approvedKey: string;
  status?: BindingStatus;
  opId: string;
  existingByDriver: IdentityBinding | null;
  existingByApproved: IdentityBinding | null;
}): BindDecision {
  if (!DRIVER_UUID_RE.test(input.driverId)) {
    return { action: 'refuse', reason: 'driver_id_malformed' };
  }
  if (!APPROVED_KEY_RE.test(input.approvedKey)) {
    return { action: 'refuse', reason: 'approved_key_malformed' };
  }
  const byDriver = input.existingByDriver;
  const byApproved = input.existingByApproved;
  const intended: IdentityBinding = {
    driverId: input.driverId,
    approvedKey: input.approvedKey,
    status: input.status || 'active',
    opId: input.opId,
  };

  if (byDriver && !pairMatches(byDriver, input.driverId, input.approvedKey)) {
    return { action: 'refuse', reason: 'driver_already_bound' };
  }
  if (byApproved && !pairMatches(byApproved, input.driverId, input.approvedKey)) {
    return { action: 'refuse', reason: 'approved_key_already_bound' };
  }

  if (byDriver && byApproved) {
    if (bindingsAgree(byDriver, byApproved) && pairMatches(byDriver, input.driverId, input.approvedKey)) {
      if (byDriver.status === intended.status) return { action: 'already_exact' };
      return {
        action: 'repair',
        payload: { ...byDriver, status: intended.status },
      };
    }
    return {
      action: 'repair',
      payload: {
        driverId: input.driverId,
        approvedKey: input.approvedKey,
        status: intended.status,
        opId: byDriver.opId === byApproved.opId ? byDriver.opId : intended.opId,
      },
    };
  }

  if (byDriver && !byApproved) {
    return {
      action: 'repair',
      payload: {
        driverId: byDriver.driverId,
        approvedKey: byDriver.approvedKey,
        status: intended.status,
        opId: byDriver.opId,
      },
    };
  }
  if (byApproved && !byDriver) {
    return {
      action: 'repair',
      payload: {
        driverId: byApproved.driverId,
        approvedKey: byApproved.approvedKey,
        status: intended.status,
        opId: byApproved.opId,
      },
    };
  }

  return { action: 'write', payload: intended };
}

export function decideBindingTerminalProof(input: {
  driverId: string;
  approvedKey: string;
  byDriver: IdentityBinding | null;
  byApproved: IdentityBinding | null;
}): { ok: true; binding: IdentityBinding } | { ok: false; reason: string } {
  if (!input.byDriver && !input.byApproved) {
    return { ok: false, reason: 'binding_missing' };
  }
  if (!input.byDriver || !input.byApproved) {
    return { ok: false, reason: 'binding_incomplete' };
  }
  if (!bindingsAgree(input.byDriver, input.byApproved)) {
    return { ok: false, reason: 'binding_disagree' };
  }
  if (input.byDriver.driverId !== input.driverId) {
    return { ok: false, reason: 'binding_driver_mismatch' };
  }
  if (input.byDriver.approvedKey !== input.approvedKey) {
    return { ok: false, reason: 'binding_key_mismatch' };
  }
  return { ok: true, binding: input.byDriver };
}

export interface IdentityProofRecord {
  secureLoginAt: number | null;
  secureLoginDriverId: string | null;
  secureLoginUid: string | null;
  hydrationAt: number | null;
  hydrationDriverId: string | null;
}

export function parseIdentityProof(raw: unknown): IdentityProofRecord {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    secureLoginAt: typeof o.secureLoginAt === 'number' && Number.isFinite(o.secureLoginAt) ? o.secureLoginAt : null,
    secureLoginDriverId: typeof o.secureLoginDriverId === 'string' ? o.secureLoginDriverId : null,
    secureLoginUid: typeof o.secureLoginUid === 'string' ? o.secureLoginUid : null,
    hydrationAt: typeof o.hydrationAt === 'number' && Number.isFinite(o.hydrationAt) ? o.hydrationAt : null,
    hydrationDriverId: typeof o.hydrationDriverId === 'string' ? o.hydrationDriverId : null,
  };
}

export function secureLoginIsProven(proof: IdentityProofRecord, driverId: string): boolean {
  return !!proof.secureLoginAt && proof.secureLoginDriverId === driverId;
}

export function hydrationIsProven(proof: IdentityProofRecord, driverId: string): boolean {
  return !!proof.hydrationAt && proof.hydrationDriverId === driverId;
}

export type RetireDecision =
  | { action: 'retire' }
  | { action: 'repair' }
  | { action: 'already_retired' }
  | { action: 'refuse'; reason: string };

/**
 * Legacy login retirement is a separate audited action. It requires both
 * server-side proofs, a complete bidirectional binding, and never deletes
 * history or the binding used for trusted history alias resolution.
 */
export function decideRetireLegacyLogin(input: {
  byDriver: IdentityBinding | null;
  byApproved: IdentityBinding | null;
  proof: IdentityProofRecord;
  approvedLegacyLoginRetired?: boolean;
}): RetireDecision {
  const term = decideBindingTerminalProof({
    driverId: input.byDriver?.driverId || input.byApproved?.driverId || '',
    approvedKey: input.byDriver?.approvedKey || input.byApproved?.approvedKey || '',
    byDriver: input.byDriver,
    byApproved: input.byApproved,
  });
  if (!term.ok) {
    if (term.reason === 'binding_incomplete') return { action: 'repair' };
    return { action: 'refuse', reason: term.reason };
  }
  if (!secureLoginIsProven(input.proof, term.binding.driverId)) {
    return { action: 'refuse', reason: 'secure_login_unproven' };
  }
  if (!hydrationIsProven(input.proof, term.binding.driverId)) {
    return { action: 'refuse', reason: 'hydration_unproven' };
  }
  if (term.binding.status === 'legacy_login_retired' && input.approvedLegacyLoginRetired === true) {
    return { action: 'already_retired' };
  }
  if (term.binding.status === 'legacy_login_retired' && input.approvedLegacyLoginRetired !== true) {
    return { action: 'repair' };
  }
  return { action: 'retire' };
}

export function retirePreviewDigest(input: {
  driverId: string;
  binding: IdentityBinding;
  proof: IdentityProofRecord;
}): string {
  return createHash('sha256').update(JSON.stringify({
    driverId: input.driverId,
    binding: input.binding,
    proof: input.proof,
  })).digest('hex');
}

export function legacyLoginIsRetired(input: {
  approvedKey: string;
  approvedRow: Record<string, unknown> | null;
  byApproved: IdentityBinding | null;
}): boolean {
  if (input.byApproved?.status === 'legacy_login_retired') return true;
  if (input.approvedRow && input.approvedRow.legacyLoginRetired === true) return true;
  return false;
}

export const BINDING_ROOT = 'drivers/identityBindings';
export const BINDING_BY_DRIVER = (driverId: string) =>
  `${BINDING_ROOT}/byDriver/${driverId}`;
export const BINDING_BY_APPROVED = (approvedKey: string) =>
  `${BINDING_ROOT}/byApproved/${approvedKey}`;
export const IDENTITY_PROOF = (driverId: string) =>
  `drivers/identityProofs/${driverId}`;
