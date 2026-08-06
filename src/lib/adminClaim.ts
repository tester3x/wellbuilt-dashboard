/**
 * Verified platform-administrator authority (vc51.9A4).
 *
 * PROVEN FOUNDATION: the Dashboard signs in with Firebase Authentication
 * (`signInWithEmailAndPassword`, src/lib/auth.ts:242) against the
 * `wellbuilt-sync` app, with `onAuthStateChanged` session restore and a
 * real Auth UID (`result.user.uid`). That UID — not any Firestore/RTDB
 * profile field — is the only identity a Cloud Function or security rule
 * can verify.
 *
 * AUTHORITY MODEL (deliberately minimal):
 *   platform admin  ⇔  verified Firebase ID token carrying the
 *                      server-assigned custom claim wellbuiltAdmin === true
 *
 * The claim is assigned ONLY through the Admin SDK in a privileged
 * environment (see tools/bootstrap-admin-claim.mjs). It is a pure
 * authority bit: no company settings, plan definitions, capability
 * arrays, mutable policy, or personal data may ever live in a custom
 * claim — those belong in Firestore documents the callable validates.
 *
 * WHAT IS *NOT* AUTHORITY:
 *   - `viewAdmin` and every other Capability: client-visible role data
 *     read from RTDB/Firestore. It may control legacy navigation
 *     presentation, never a protected operation.
 *   - a Firestore/RTDB profile that merely says "admin".
 *   - anything in a request body.
 * Only the token claim counts, and the callable — not the caller — is
 * the authority. Customer/company-scoped writes need their own verified
 * membership proof and remain out of scope here.
 *
 * Pure and dependency-free so the same predicate is unit-tested and
 * reused by the client (to decide what to SHOW) and by callables (to
 * decide what to ALLOW).
 */

export const WELLBUILT_ADMIN_CLAIM = 'wellbuiltAdmin' as const;

/** The shape of a decoded ID token's claims that we are willing to read. */
export interface DecodedClaims {
  [key: string]: unknown;
}

/** An authenticated caller as a callable sees it (`request.auth`). */
export interface CallerAuth {
  uid?: string | null;
  token?: DecodedClaims | null;
}

export type AdminDenialReason =
  | 'unauthenticated'
  | 'missing_admin_claim'
  | 'claim_not_true';

export type AdminAuthorization =
  | { ok: true; actorUid: string; actorEmail: string | null }
  | { ok: false; reason: AdminDenialReason };

/**
 * The ONE authorization decision for platform-admin operations.
 *
 * Strict `=== true`: a truthy string, 1, or an object never authorizes.
 * The actor is derived from the verified token only — any actor fields a
 * client puts in the request body are ignored by construction, because
 * this function never sees the body.
 */
export function authorizePlatformAdmin(auth: CallerAuth | null | undefined): AdminAuthorization {
  if (!auth || !auth.uid || !auth.token) return { ok: false, reason: 'unauthenticated' };
  const claim = (auth.token as DecodedClaims)[WELLBUILT_ADMIN_CLAIM];
  if (claim === undefined || claim === null) return { ok: false, reason: 'missing_admin_claim' };
  if (claim !== true) return { ok: false, reason: 'claim_not_true' };
  const emailRaw = (auth.token as DecodedClaims).email;
  return {
    ok: true,
    actorUid: auth.uid,
    actorEmail: typeof emailRaw === 'string' && emailRaw.length > 0 ? emailRaw : null,
  };
}

/**
 * Client-side UI gate. Mirrors the callable decision so admin controls
 * stay hidden until the refreshed ID token actually carries the claim —
 * the callable remains authoritative regardless of what the UI shows.
 */
export function hasVerifiedAdminClaim(tokenClaims: DecodedClaims | null | undefined): boolean {
  return !!tokenClaims && tokenClaims[WELLBUILT_ADMIN_CLAIM] === true;
}

/**
 * Audit metadata for a protected mutation. Actor identity comes from the
 * verified token; the server supplies the timestamp. Bounded on purpose:
 * no tokens, no full payloads, no personal data beyond the admin's own
 * account email.
 */
export interface AdminAuditStamp {
  actorUid: string;
  actorEmail: string | null;
  action: string;
  atServerTime: true;
}

export function buildAdminAuditStamp(authz: AdminAuthorization, action: string): AdminAuditStamp | null {
  if (!authz.ok) return null;
  return { actorUid: authz.actorUid, actorEmail: authz.actorEmail, action, atServerTime: true };
}
