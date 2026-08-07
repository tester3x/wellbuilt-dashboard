/**
 * Production wrappers for the SSO authorization-code bridge.
 *
 * Mirrors the admin/callables.ts discipline exactly: a thin, obviously
 * correct adapter that builds real Admin-SDK dependencies and maps typed
 * handler failures onto bounded callable errors. All logic lives in the
 * handlers, which stay independently testable through injected deps.
 *
 * APP CHECK: enforceAppCheck stays false, matching ADMIN_CALLABLE_OPTIONS
 * and the driver-auth callables. Turning it on here would silently impose
 * a requirement WB-S and WB-T clients do not yet satisfy, which is a
 * rollout decision and not this packet's to make.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash, randomBytes } from 'crypto';
import { checkRateLimit, hashIp } from '../security/rateLimit';
import { handleSsoIssueCode } from './ssoIssueHandler';
import { handleSsoExchange } from './ssoExchangeHandler';
import {
  SsoError,
  type AuthoritativeDriver,
  type SsoDeps,
  type SsoTransaction,
} from './ssoDeps';

/** Same rollout posture as the other callables in this project. */
export const SSO_CALLABLE_OPTIONS = {
  timeoutSeconds: 30,
  memory: '256MiB',
  // Flip to true only when App Check enforcement is approved live for
  // WB-S and WB-T together. See ADMIN_CALLABLE_OPTIONS.
  enforceAppCheck: false,
} as const;

const fs = () => admin.firestore();
const rtdb = () => admin.database();

/** Production SsoDeps over the real Admin SDK. */
export function buildSsoDeps(): SsoDeps {
  const db = fs();
  return {
    nowMs: () => Date.now(),
    randomBytes: (count) => new Uint8Array(randomBytes(count)),
    sha256Hex: (input) => createHash('sha256').update(input, 'utf8').digest('hex'),
    base64Url: (bytes) => Buffer.from(bytes).toString('base64url'),

    /**
     * Authoritative driver liveness and company.
     *
     * `driver_credentials/{driverId}.active !== false` is the same
     * liveness test requestDriverRegistration already uses; the company
     * comes from the RTDB profile, which is what authenticateDriver mints
     * claims from. Reading both means a driver disabled OR moved since
     * sign-in fails this check.
     */
    async getDriver(driverId): Promise<AuthoritativeDriver | null> {
      const [credSnap, profileSnap] = await Promise.all([
        db.collection('driver_credentials').doc(driverId).get(),
        rtdb().ref(`drivers/profiles/${driverId}`).once('value'),
      ]);
      if (!credSnap.exists) return null;
      const profile = (profileSnap.val() || {}) as { companyId?: string };
      return {
        driverId,
        companyId: typeof profile.companyId === 'string' && profile.companyId
          ? profile.companyId
          : null,
        active: credSnap.data()?.active !== false,
      };
    },

    runTransaction(fn) {
      return db.runTransaction(async (tx) => {
        const adapter: SsoTransaction = {
          async get(path) {
            const snap = await tx.get(db.doc(path));
            return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
          },
          update(path, fields) { tx.update(db.doc(path), fields); },
          create(path, data) { tx.create(db.doc(path), data); },
        };
        return fn(adapter);
      });
    },

    /**
     * Mint with DEVELOPER claims only.
     *
     * setCustomUserClaims is deliberately NOT called. WB-S and WB-T are
     * the same Firebase project and the same UID, so persisted claims are
     * shared: writing an app marker there would contaminate WB-S's live
     * session and every other app's. Developer claims ride in this token
     * alone and expire with it.
     */
    async mintCustomToken(uid, developerClaims) {
      return admin.auth().createCustomToken(uid, developerClaims);
    },

    /**
     * Redacted structured log.
     *
     * Handlers already pass only non-secret fields; this strips anything
     * that looks like a secret as a second line of defence, because a
     * future edit adding a field is likelier than a future edit adding a
     * redaction.
     */
    log(event, fields) {
      const safe: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (/code$|verifier|challenge|token|passcode|hash$|url/i.test(k)
          && k !== 'codeHashPrefix' && k !== 'errorCode' && k !== 'publicCode') {
          continue;
        }
        safe[k] = v;
      }
      console.log(`[sso] ${event}`, JSON.stringify(safe));
    },
  };
}

function clientIpHash(request: httpsV2.CallableRequest): string {
  const ip =
    (request.rawRequest?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || request.rawRequest?.ip
    || undefined;
  return hashIp(ip);
}

/** Map a typed handler failure onto a bounded callable error. */
function toHttpsError(err: unknown): httpsV2.HttpsError {
  if (err instanceof SsoError) {
    // internalReason is operator-facing and stays in the log.
    console.warn('[sso] rejected:', err.publicCode, '|', err.internalReason);
    return new httpsV2.HttpsError(err.code, err.publicCode, { ssoCode: err.publicCode });
  }
  console.error('[sso] unexpected failure:', (err as Error)?.message);
  return new httpsV2.HttpsError('internal', 'internal', { ssoCode: 'internal' });
}

// ── issuance ──────────────────────────────────────────────────────────────

/**
 * WB-S asks for an authorization code for WB-T.
 *
 * Requires callable Auth. The identity bound into the code comes from
 * request.auth and authoritative records only — never from request.data.
 */
export const ssoIssueAuthorizationCode = httpsV2.onCall(
  SSO_CALLABLE_OPTIONS,
  async (request) => {
    // Anonymous callers never reach the handler or the rate limiter's
    // per-driver bucket.
    if (!request.auth?.uid) {
      throw new httpsV2.HttpsError('unauthenticated', 'not_authorized', {
        ssoCode: 'not_authorized',
      });
    }
    // Bucketed by UID, not IP: a shared yard NAT must not let one driver
    // exhaust everyone else's bridge.
    const allowed = await checkRateLimit({
      bucket: 'sso_issue',
      key: request.auth.uid,
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'unavailable', {
        ssoCode: 'unavailable',
      });
    }
    try {
      return await handleSsoIssueCode(
        buildSsoDeps(),
        {
          uid: request.auth.uid,
          claims: (request.auth.token || {}) as unknown as Record<string, unknown>,
        },
        request.data,
      );
    } catch (err) {
      throw toHttpsError(err);
    }
  },
);

// ── exchange ──────────────────────────────────────────────────────────────

/**
 * WB-T redeems the code.
 *
 * Deliberately does NOT require callable Auth: this runs before WB-T has
 * any session, which is the whole point of the bridge. Authorization is
 * possession of the code AND the PKCE verifier. Pretending an Auth
 * context exists here would be theatre.
 *
 * Rate limited by IP hash since there is no UID to bucket by. This is the
 * anti-guessing control; the code space itself is 256 bits.
 */
export const ssoExchangeAuthorizationCode = httpsV2.onCall(
  SSO_CALLABLE_OPTIONS,
  async (request) => {
    const allowed = await checkRateLimit({
      bucket: 'sso_exchange',
      key: clientIpHash(request),
      limit: 30,
      windowMs: 10 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'invalid_grant', {
        ssoCode: 'invalid_grant',
      });
    }
    try {
      return await handleSsoExchange(buildSsoDeps(), request.data);
    } catch (err) {
      throw toHttpsError(err);
    }
  },
);
