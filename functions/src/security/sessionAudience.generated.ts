/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Verbatim copy of the canonical session audience contract from
 * @tester3x/wellbuilt-contracts src/auth/sessionAudience.ts at version
 * 0.3.0-dev.0 (UNPUBLISHED).
 *
 * Regenerate:  node tools/mirror-session-audience.mjs --regenerate
 * Verify:      node tools/mirror-session-audience.mjs --verify
 *
 * This exists only because the contracts package mirror is SHA-pinned to
 * the published 0.2.0 artifact and cannot carry an unpublished bump.
 * When the session audience contract is published, delete this file and import from
 * the package instead.
 */
// @generated from wellbuilt-contracts/src/auth/sessionAudience.ts
/**
 * Optional session audience for driver authentication (vc51.9K).
 *
 * `authenticateDriver` mints one session for whichever app asked. Because
 * WB-S, WB-T, WB-M, WB-JSA and eQuipment are ONE Firebase project with
 * one Auth UID per driver, a session minted for one app is
 * indistinguishable from a session minted for another. The audience makes
 * that distinction explicit, as a per-session marker on the custom token.
 *
 * WHAT THIS IS NOT. The audience is protocol input from a client that
 * already holds valid credentials. It is NOT proof that an untampered
 * WB-T binary made the request, and it is NOT device attestation or a
 * substitute for App Check. See docs/SSO-AUDIENCE-MEANING.md.
 *
 * BACKWARD COMPATIBLE BY CONSTRUCTION. Absent audience preserves exactly
 * today's behavior for every existing caller. A client that never learns
 * this field keeps working forever.
 *
 * Pure and node-testable: no imports, no platform APIs, no clock.
 */

/** The only audience this version supports. */
export const SESSION_AUDIENCE_WBT = 'wbt' as const;
export type SessionAudience = typeof SESSION_AUDIENCE_WBT;

export const SESSION_AUDIENCES: readonly SessionAudience[] = Object.freeze([
  SESSION_AUDIENCE_WBT,
]);

/**
 * The claim name carried on the custom token for an audience-scoped
 * session. Deliberately the same name the SSO bridge already mints, so a
 * verifier cannot tell an SSO session from a manual one — both are
 * legitimately WB-T.
 */
export const SESSION_APP_CLAIM = 'app' as const;

export function isSessionAudience(v: unknown): v is SessionAudience {
  return typeof v === 'string' && (SESSION_AUDIENCES as readonly string[]).includes(v);
}

export type SessionAudienceOutcome =
  /** No audience requested — legacy behavior, no app claim. */
  | { kind: 'absent' }
  /** A supported audience. */
  | { kind: 'audience'; audience: SessionAudience }
  /** Present but not allowlisted, or not a string. Fail closed. */
  | { kind: 'rejected'; reason: 'unsupported_audience' };

/**
 * Read the audience from an authentication request body.
 *
 * Only the `audience` key is consulted. A client can never submit `app`,
 * a developer-claims object, or any other claim material: those are not
 * read here and are rejected by `containsClientClaimMaterial` below.
 */
export function readSessionAudience(request: unknown): SessionAudienceOutcome {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { kind: 'absent' };
  }
  const raw = (request as Record<string, unknown>).audience;
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (!isSessionAudience(raw)) return { kind: 'rejected', reason: 'unsupported_audience' };
  return { kind: 'audience', audience: raw };
}

/**
 * Claim material a client may never submit.
 *
 * `audience` is an allowlisted protocol input; `app`, `claims`, and
 * friends are outputs of server authorization. A request carrying them is
 * either hostile or dangerously out of date, so it is a hard reject
 * rather than a silent ignore.
 */
export const CLIENT_FORBIDDEN_CLAIM_KEYS: readonly string[] = Object.freeze([
  'app',
  'claims',
  'customClaims',
  'developerClaims',
  'kind',
  'driverId',
  'companyId',
  'roles',
  'uid',
  'authUid',
  'mustChangePasscode',
]);

/** True when the request tries to dictate claims. Case-insensitive. */
export function containsClientClaimMaterial(request: unknown): boolean {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return false;
  const forbidden = CLIENT_FORBIDDEN_CLAIM_KEYS.map((k) => k.toLowerCase());
  return Object.keys(request as Record<string, unknown>)
    .some((k) => forbidden.includes(k.toLowerCase()));
}

/**
 * The per-session developer claims for an audience.
 *
 * Returns an EMPTY object when no audience was requested, so the absent
 * case cannot accidentally inherit a marker. Callers spread this into
 * createCustomToken's developer claims and never into setCustomUserClaims.
 */
export function sessionClaimsForAudience(
  outcome: SessionAudienceOutcome,
): Readonly<Record<string, string>> {
  if (outcome.kind !== 'audience') return Object.freeze({});
  return Object.freeze({ [SESSION_APP_CLAIM]: outcome.audience });
}
