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
export declare const SESSION_AUDIENCE_WBT: "wbt";
export type SessionAudience = typeof SESSION_AUDIENCE_WBT;
export declare const SESSION_AUDIENCES: readonly SessionAudience[];
/**
 * The claim name carried on the custom token for an audience-scoped
 * session. Deliberately the same name the SSO bridge already mints, so a
 * verifier cannot tell an SSO session from a manual one — both are
 * legitimately WB-T.
 */
export declare const SESSION_APP_CLAIM: "app";
export declare function isSessionAudience(v: unknown): v is SessionAudience;
export type SessionAudienceOutcome = 
/** No audience requested — legacy behavior, no app claim. */
{
    kind: 'absent';
}
/** A supported audience. */
 | {
    kind: 'audience';
    audience: SessionAudience;
}
/** Present but not allowlisted, or not a string. Fail closed. */
 | {
    kind: 'rejected';
    reason: 'unsupported_audience';
};
/**
 * Read the audience from an authentication request body.
 *
 * Only the `audience` key is consulted. A client can never submit `app`,
 * a developer-claims object, or any other claim material: those are not
 * read here and are rejected by `containsClientClaimMaterial` below.
 */
export declare function readSessionAudience(request: unknown): SessionAudienceOutcome;
/**
 * Claim material a client may never submit.
 *
 * `audience` is an allowlisted protocol input; `app`, `claims`, and
 * friends are outputs of server authorization. A request carrying them is
 * either hostile or dangerously out of date, so it is a hard reject
 * rather than a silent ignore.
 */
export declare const CLIENT_FORBIDDEN_CLAIM_KEYS: readonly string[];
/** True when the request tries to dictate claims. Case-insensitive. */
export declare function containsClientClaimMaterial(request: unknown): boolean;
/**
 * The per-session developer claims for an audience.
 *
 * Returns an EMPTY object when no audience was requested, so the absent
 * case cannot accidentally inherit a marker. Callers spread this into
 * createCustomToken's developer claims and never into setCustomUserClaims.
 */
export declare function sessionClaimsForAudience(outcome: SessionAudienceOutcome): Readonly<Record<string, string>>;
//# sourceMappingURL=sessionAudience.d.ts.map