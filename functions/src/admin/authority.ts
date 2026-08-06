/**
 * Server-side platform-admin authority (vc51.9A5) — the authoritative
 * gate every protected admin callable must route through.
 *
 * Self-contained inside the Functions build boundary on purpose: the
 * Dashboard's src/lib/adminClaim.ts makes the same decision for DISPLAY,
 * but Functions must never import across an unsafe source path, and the
 * client copy must never be able to influence the server's answer.
 *
 * TWO INDEPENDENT REQUIREMENTS — both must hold:
 *
 *   1. a verified Firebase ID token carrying the server-assigned custom
 *      claim `wellbuiltAdmin === true` (cryptographic administrator
 *      class), and
 *   2. an exact, server-owned, enabled `platform_admins/{uid}` record.
 *
 * Why both: a custom claim rides in already-issued tokens with a bounded
 * lifetime, so revoking it alone cannot stop an in-flight admin session
 * immediately. The server record is read on every call, so disabling it
 * denies the very next request — no waiting for token expiry. Conversely
 * the record alone proves nothing cryptographically, so a record without
 * the claim is equally denied.
 *
 * NEVER consulted here: request body fields, Firestore/RTDB client-visible
 * roles, `viewAdmin`, company profile capabilities, email allowlists,
 * caller-supplied actor identity, or UI visibility state. The actor is
 * derived from the verified token only.
 *
 * Pure and dependency-free so the whole matrix is unit-testable without
 * the emulator; the callable layer supplies `auth` from CallableRequest
 * and `record` from an Admin SDK exact read.
 */

export const WELLBUILT_ADMIN_CLAIM = 'wellbuiltAdmin' as const;
export const PLATFORM_ADMINS_COLLECTION = 'platform_admins' as const;
/** Bumped if the admin-state contract changes shape. */
export const ADMIN_POLICY_VERSION = 1 as const;

export interface VerifiedCallerAuth {
  uid?: string | null;
  token?: Record<string, unknown> | null;
}

/**
 * Server-owned admin state. Bounded on purpose: operational enable/disable
 * only — never capabilities, company policy, or personal data.
 */
export interface PlatformAdminRecord {
  enabled?: unknown;
  policyVersion?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  createdBy?: unknown;
  updatedBy?: unknown;
  disabledAt?: unknown;
}

export type AdminDenialReason =
  | 'unauthenticated'
  | 'missing_admin_claim'
  | 'claim_not_true'
  | 'no_admin_record'
  | 'admin_record_disabled'
  | 'admin_record_malformed'
  | 'unsupported_policy_version';

export type ServerAdminAuthorization =
  | { ok: true; actorUid: string; actorEmail: string | null; policyVersion: number }
  | { ok: false; reason: AdminDenialReason };

/**
 * THE decision. `record` is the exact `platform_admins/{uid}` document as
 * read by the Admin SDK, or null when it does not exist.
 */
export function authorizeAdminCall(
  auth: VerifiedCallerAuth | null | undefined,
  record: PlatformAdminRecord | null | undefined,
): ServerAdminAuthorization {
  // 1. Cryptographic administrator class.
  if (!auth || !auth.uid || !auth.token) return { ok: false, reason: 'unauthenticated' };
  const claim = auth.token[WELLBUILT_ADMIN_CLAIM];
  if (claim === undefined || claim === null) return { ok: false, reason: 'missing_admin_claim' };
  if (claim !== true) return { ok: false, reason: 'claim_not_true' };

  // 2. Server-owned operational state — checked on EVERY call so a
  //    disable takes effect immediately, not at token expiry.
  if (!record) return { ok: false, reason: 'no_admin_record' };
  if (typeof record.enabled !== 'boolean') return { ok: false, reason: 'admin_record_malformed' };
  if (typeof record.policyVersion !== 'number') return { ok: false, reason: 'admin_record_malformed' };
  if (record.policyVersion !== ADMIN_POLICY_VERSION) {
    return { ok: false, reason: 'unsupported_policy_version' };
  }
  if (record.enabled !== true) return { ok: false, reason: 'admin_record_disabled' };

  const emailRaw = auth.token.email;
  return {
    ok: true,
    actorUid: auth.uid,
    actorEmail: typeof emailRaw === 'string' && emailRaw.length > 0 ? emailRaw : null,
    policyVersion: ADMIN_POLICY_VERSION,
  };
}

/**
 * Bootstrap ordering. Auth custom claims and Firestore cannot share a
 * transaction, so order is what makes partial failure safe: every
 * intermediate state must deny.
 */
export type BootstrapStep =
  | 'create_pending_record'
  | 'set_claim'
  | 'verify_claim'
  | 'enable_record';
export type TeardownStep =
  | 'disable_record'
  | 'remove_claim'
  | 'revoke_refresh_tokens'
  | 'verify_final_state';

/** Enable: the record is only enabled AFTER the claim is verified. */
export const ENABLE_ORDER: readonly BootstrapStep[] = Object.freeze([
  'create_pending_record',
  'set_claim',
  'verify_claim',
  'enable_record',
]);

/** Disable: the record is disabled FIRST so access stops immediately. */
export const DISABLE_ORDER: readonly TeardownStep[] = Object.freeze([
  'disable_record',
  'remove_claim',
  'revoke_refresh_tokens',
  'verify_final_state',
]);

/**
 * Would the state after completing `completed` steps authorize a call?
 * Used to prove every partial bootstrap/teardown state fails closed.
 */
export function authorizesAfterEnableSteps(completed: BootstrapStep[]): boolean {
  const done = new Set(completed);
  // Only the full sequence yields claim=true AND an enabled record.
  return done.has('set_claim') && done.has('enable_record');
}

export function authorizesAfterDisableSteps(completed: TeardownStep[]): boolean {
  // The very first step already denies, regardless of the stale claim.
  return !completed.includes('disable_record');
}
