/**
 * Canonical WB-S → WB-T SSO authorization-code protocol (vc51.9J).
 *
 * An OAuth-style authorization-code exchange with PKCE, carried over
 * device deep links. It replaces the legacy scheme in which WB-S passed a
 * driver passcode HASH in the launch URL and the receiving app treated
 * possession of that hash as proof of identity. Nothing here accepts,
 * emits, or derives authority from a passcode or passcode hash.
 *
 * WHY AN AUTHORIZATION CODE AND NOT A TOKEN IN THE URL
 * A deep link is not a confidential channel: it can be logged by the OS,
 * captured by another app registering the same scheme, and replayed. So
 * the link carries only an opaque, single-use, short-lived reference. The
 * bearer must additionally prove possession of a secret (the PKCE
 * verifier) that never appears in any URL, and the server consumes the
 * code exactly once.
 *
 * SINGLE FIREBASE PROJECT. WB-S and WB-T are the same Firebase project
 * (wellbuilt-sync) and one driver is one Auth UID. `audience` is
 * therefore a PROTOCOL-level binding — it stops a code issued for WB-T
 * being redeemed by another app — not a cryptographic project boundary.
 * The exchange adds a per-session `app` claim so a consumer can tell
 * which application is acting; see SSO_SESSION_APP_CLAIM.
 *
 * INDEPENDENT VERSION. SSO_PROTOCOL_VERSION is deliberately separate
 * from CONTRACT_VERSION and DVIR_PROTOCOL_VERSION. Unknown versions fail
 * closed.
 *
 * ADDITIVE ONLY. Nothing here changes any 0.1.0 or 0.2.0 export.
 *
 * Pure and node-testable: no runtime imports, no platform APIs, no
 * randomness, no clock. Callers supply randomness and time.
 */
export declare const SSO_PROTOCOL_VERSION: 1;
export type SsoProtocolVersion = typeof SSO_PROTOCOL_VERSION;
export declare const SUPPORTED_SSO_PROTOCOL_VERSIONS: readonly number[];
/** Fail closed on any unknown/future protocol version. */
export declare function assertSsoProtocolCompatible(version: number, consumerName: string): void;
export declare function isSsoProtocolVersion(v: unknown): v is SsoProtocolVersion;
/** The only audience this protocol version issues codes for. */
export declare const SSO_AUDIENCE_WBT: "wellbuilt-tickets";
/**
 * vc51.9AE — WB eQuipment. Added because eQuipment's DVIR handoff
 * previously carried a passcode-derived hash in its launch URI and treated
 * possession of it as identity. It joins the same authorization-code
 * exchange rather than getting a parallel protocol.
 */
export declare const SSO_AUDIENCE_EQUIPMENT: "wellbuilt-equipment";
/**
 * JSA-audience addendum — WB-JSA. Added because WB-JSA's launch previously
 * carried a passcode-derived hash and display name in `jsaapp://start` and
 * treated possession of them as identity — which is how a stale legacy
 * session reused a June shift during an active August one. WB-JSA joins
 * the same authorization-code exchange; its launch link (see
 * ./jsaLaunch.ts) carries only non-authoritative request metadata.
 */
export declare const SSO_AUDIENCE_JSA: "wellbuilt-jsa";
export type SsoAudience = typeof SSO_AUDIENCE_WBT | typeof SSO_AUDIENCE_EQUIPMENT | typeof SSO_AUDIENCE_JSA;
export declare const SSO_AUDIENCES: readonly SsoAudience[];
export declare function isSsoAudience(v: unknown): v is SsoAudience;
/**
 * Per-session claim naming the application a token was minted for.
 *
 * Rides in the custom token's developer claims, NOT in setCustomUserClaims:
 * persisted claims live on the Auth USER and are shared by every app, so
 * writing an app marker there would corrupt WB-S's own session. Developer
 * claims are per-token and expire with it.
 */
export declare const SSO_SESSION_APP_CLAIM: "app";
export declare const SSO_SESSION_APP_WBT: "wbt";
export declare const SSO_SESSION_APP_EQUIPMENT: "equipment";
/** Matches the established 'wbjsa' switcher alias family; claim stays short. */
export declare const SSO_SESSION_APP_JSA: "jsa";
/**
 * Audience → per-session app claim. A map rather than a conditional so a
 * new audience cannot be added without deciding what it is called in the
 * minted token.
 */
export declare const SSO_SESSION_APP_BY_AUDIENCE: Readonly<Record<SsoAudience, string>>;
/** Only S256. `plain` is never acceptable. */
export declare const SSO_CHALLENGE_METHOD: "S256";
export type SsoChallengeMethod = typeof SSO_CHALLENGE_METHOD;
export declare function isSsoChallengeMethod(v: unknown): v is SsoChallengeMethod;
/** Every protocol secret is 256 bits. Nothing weaker is representable. */
export declare const SSO_STATE_BYTES = 32;
export declare const SSO_VERIFIER_BYTES = 32;
export declare const SSO_CODE_BYTES = 32;
/** base64url of exactly 32 bytes, unpadded. */
export declare const SSO_B64URL_32_LENGTH = 43;
/**
 * Patterns are exported as STRINGS, never as RegExp singletons.
 *
 * A frozen RegExp with the `g` or `y` flag throws on its second `.test()`
 * because it cannot write `lastIndex`; exporting the source avoids
 * handing consumers any shared mutable matcher at all.
 */
export declare const SSO_STATE_PATTERN = "^[A-Za-z0-9_-]{43}$";
export declare const SSO_CODE_PATTERN = "^[A-Za-z0-9_-]{43}$";
export declare const SSO_CHALLENGE_PATTERN = "^[A-Za-z0-9_-]{43}$";
/**
 * RFC 7636 §4.1 code verifier: 43–128 characters of the unreserved set
 * ALPHA / DIGIT / "-" / "." / "_" / "~". We always mint exactly 43
 * (base64url of 256 bits) but accept the full legal range so a future
 * client is not locked out by our own generator's choice.
 */
export declare const SSO_VERIFIER_PATTERN = "^[A-Za-z0-9\\-._~]{43,128}$";
export declare function isSsoState(v: unknown): v is string;
export declare function isSsoCode(v: unknown): v is string;
export declare function isSsoChallenge(v: unknown): v is string;
export declare function isSsoVerifier(v: unknown): v is string;
export declare const SSO_AUTHORIZE_SCHEME: "wellbuilt-suite";
export declare const SSO_AUTHORIZE_HOST: "sso-authorize";
export declare const SSO_CALLBACK_SCHEME: "wellbuilt-tickets";
export declare const SSO_CALLBACK_HOST: "sso-callback";
/** vc51.9AE — eQuipment's fixed callback identity. Same host, own scheme. */
export declare const SSO_CALLBACK_SCHEME_EQUIPMENT: "wbequipment";
/** JSA addendum — WB-JSA's registered scheme. Same fixed host, own scheme. */
export declare const SSO_CALLBACK_SCHEME_JSA: "jsaapp";
/**
 * Audience → fixed callback route. Still constants, never a client-supplied
 * redirect URI: the destination is chosen by the audience the code was
 * issued for, so a code cannot be steered to a different application.
 */
export declare const SSO_CALLBACK_BY_AUDIENCE: Readonly<Record<SsoAudience, {
    scheme: string;
    host: string;
}>>;
/**
 * DVIR phase, kept textually identical to the 0.2.0 DVIR_PHASES enum.
 *
 * Deliberately NOT re-exported and NOT imported from ../dvir: this module
 * documents itself as having no runtime imports, and duplicating the export
 * would put two names for one enum on the public surface — the exact drift
 * this package exists to prevent. tools/test-sso-protocol.mjs asserts the
 * two agree, so a change to either is caught rather than silently tolerated.
 */
export type SsoDvirPhase = 'pre_trip' | 'post_trip';
/**
 * Shift-scoped binding carried on an equipment authorization.
 *
 * eQuipment's DVIR records are shift-scoped, so the bridge must name the
 * exact period rather than letting the app infer one from a launch URI it
 * cannot authenticate. The SERVER validates this against the authenticated
 * driver's authoritative shift before binding it into the code, and returns
 * it on exchange — so the app binds its DVIR to a server-verified period,
 * never to a value it was handed in a deep link.
 *
 * `shiftId` is opaque here: WB-S owns its format and this protocol only
 * requires that it be a bounded non-empty string.
 */
export interface SsoShiftBinding {
    shiftId: string;
    phase: SsoDvirPhase;
}
export declare const SSO_SHIFT_ID_MAX = 128;
export declare function isSsoShiftBinding(v: unknown): v is SsoShiftBinding;
/**
 * Shift binding is mandatory for equipment and forbidden for every other
 * audience. WB-JSA deliberately does NOT take a client-proposed binding:
 * the SERVER derives the authoritative shift state itself at issuance (see
 * SsoJsaBinding below), so there is nothing a client could propose that
 * the server would not have to discard.
 */
export declare function audienceRequiresShiftBinding(audience: SsoAudience): boolean;
/**
 * Textually identical to the shift-authority formats in the backend's
 * shiftAuthority module (PERIOD_ID_PATTERN / LOCAL_DATE_PATTERN).
 * Deliberately NOT imported — this module documents itself as having no
 * runtime imports — and the conformance test asserts the two agree, so a
 * change to either is caught rather than silently tolerated.
 */
export declare const SSO_JSA_PERIOD_ID_PATTERN = "^\\d{4}-\\d{2}-\\d{2}_\\d{6}$";
export declare const SSO_JSA_LOCAL_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
/**
 * The authoritative binding a JSA exchange returns.
 *
 * AUTHORED BY THE SERVER at issuance, from the driver's shift-authority
 * record and the company's effective plan + app configuration — never from
 * the request, a launch URI, a cached client value, or a clock-derived
 * date. This is what makes WB-JSA a governed destination: the app binds
 * its records to a server-verified period (or to none), so a stale local
 * session cannot resurrect a June shift in August.
 *
 *  - shiftState 'open'  → periodId + originLocalDate are REQUIRED and name
 *    the exact authoritative open period. originLocalDate is the period's
 *    frozen origin day — never a UTC-derived date.
 *  - shiftState 'none'  → both period fields are ABSENT. Legal only when
 *    the effective policy does not require an active shift (the
 *    owner-operator / free-plan case) — a shift-required company with no
 *    open period is refused at issuance, not represented here.
 *  - requiresActiveShift / jsaEnabled describe the effective company
 *    policy the server decided under, so the app renders the right
 *    experience without re-deriving policy from unverified data.
 */
export interface SsoJsaBinding {
    shiftState: 'open' | 'none';
    periodId?: string;
    originLocalDate?: string;
    requiresActiveShift: boolean;
    jsaEnabled: boolean;
}
export declare function isSsoJsaBinding(v: unknown): v is SsoJsaBinding;
/** The JSA audience returns a server-authored binding; no other audience does. */
export declare function audienceCarriesJsaBinding(audience: SsoAudience): boolean;
/** Upper bound on an authoritative display name carried in a response. */
export declare const SSO_DISPLAY_NAME_MAX = 120;
/**
 * Audiences whose apps persist a local identity and therefore need a name.
 * WB-JSA joins WB-T here: it supports governed DIRECT start (no Suite hop)
 * on later launches, which requires a persisted identity — and that
 * identity needs a server-resolved name, never one from a launch URI.
 * Keeping this a predicate rather than an inline comparison means the
 * server and the client cannot disagree about which audiences carry the
 * field.
 */
export declare function audienceCarriesDisplayName(audience: SsoAudience): boolean;
/**
 * Normalize an authoritative display name, or null when it is unusable.
 *
 * Shared by the server (before sending) and the client (before persisting)
 * so a name can never be stored in a shape the server would not have sent.
 *
 * Rejects control characters outright — a name reaches a receipt, a print
 * sheet and a log line, and a newline, tab, or escape sequence in any of
 * those is a defect waiting to happen. Tab counts as a control character and
 * is refused rather than quietly collapsed, so the only whitespace that can
 * survive is the space character. Spaces are trimmed and internal runs
 * collapsed, so " Mike  S " and "Mike S" cannot become two different stored
 * identities for one driver.
 *
 * Deliberately NOT a sanitizer that "fixes" bad input: anything outside the
 * accepted shape returns null and the caller omits the field.
 */
export declare function normalizeSsoDisplayName(v: unknown): string | null;
export declare const SSO_ERROR_CODES: readonly ["unsupported_protocol", "unsupported_audience", "unsupported_method", "malformed_request", "not_authorized", "unavailable", "superseded", "invalid_grant"];
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];
export declare function isSsoErrorCode(v: unknown): v is SsoErrorCode;
/** WB-T → WB-S, over the fixed authorization deep link. Non-secret only. */
export interface SsoAuthorizationRequest {
    protocolVersion: number;
    audience: SsoAudience;
    codeChallenge: string;
    codeChallengeMethod: SsoChallengeMethod;
    state: string;
}
/** WB-S → server callable. Identity comes from Auth context, never here. */
export interface SsoIssueCodeRequest {
    protocolVersion: number;
    audience: SsoAudience;
    codeChallenge: string;
    codeChallengeMethod: SsoChallengeMethod;
    /**
     * Required for the equipment audience, rejected for any other. Supplied
     * by the AUTHORIZING app (WB-S), which owns the shift lifecycle and holds
     * the authenticated session — never echoed back from the launch URI by
     * the target. The server revalidates it before binding.
     */
    shiftBinding?: SsoShiftBinding;
}
/** Server → WB-S. */
export interface SsoIssueCodeResponse {
    protocolVersion: number;
    code: string;
    /** For UX only ("this expires in N seconds"); never used as authority. */
    expiresInSeconds: number;
}
/** WB-S → WB-T, over the fixed callback deep link. */
export type SsoCallback = {
    protocolVersion: number;
    status: 'success';
    code: string;
    state: string;
} | {
    protocolVersion: number;
    status: 'error';
    errorCode: SsoErrorCode;
    /** Present when WB-S could read it; absent on a malformed request. */
    state?: string;
};
/** WB-T → server callable. Runs BEFORE WB-T has any Auth session. */
export interface SsoExchangeRequest {
    protocolVersion: number;
    audience: SsoAudience;
    code: string;
    codeVerifier: string;
}
/** Server → WB-T. */
export interface SsoExchangeResponse {
    protocolVersion: number;
    customToken: string;
    /** Authoritative identity, so WB-T can match immediately after sign-in. */
    uid: string;
    driverId: string;
    companyId: string;
    /**
     * Present only for the equipment audience: the SERVER-STORED binding, so
     * the app scopes its DVIR to a verified period rather than to anything it
     * received in a deep link.
     */
    shiftBinding?: SsoShiftBinding;
    /**
     * Present only for the jsa audience: the SERVER-AUTHORED authority
     * binding decided at issuance (see SsoJsaBinding). WB-JSA scopes its
     * records to this — never to a launch URI, a cached shift id, or a
     * UTC-derived date.
     */
    jsaBinding?: SsoJsaBinding;
    /**
     * Present only for the tickets audience: the driver's authoritative display
     * name, resolved SERVER-SIDE from the same canonical profile the exchange
     * already revalidates against.
     *
     * WHY IT IS HERE AT ALL. WB-T decides its logged-in state from a locally
     * persisted identity, and that identity needs a name as well as an id. The
     * name is not in the token claims, so without this field WB-T had to go
     * find one itself — and it looked in the legacy hash-keyed namespace, which
     * holds nothing for a canonical driver id. A cryptographically verified
     * driver was therefore left unable to persist a session.
     *
     * OPTIONAL ON PURPOSE, in both directions:
     *  - A client talking to a server that predates this field must still work.
     *    It sees the field absent and reports a bounded persistence-unavailable
     *    outcome rather than failing the grant.
     *  - A server that cannot resolve a non-empty name OMITS the field rather
     *    than failing the exchange or inventing a placeholder. The grant is
     *    already valid and already consumed; a profile-data gap must not be
     *    reported to the driver as a refusal.
     *
     * Audience-scoped like `shiftBinding` above, so no other audience's
     * response shape changes and no profile data is exposed to an app with no
     * use for it. Always passes `normalizeSsoDisplayName` before being sent.
     */
    displayName?: string;
}
export type SsoValidation<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    errorCode: SsoErrorCode;
    field: string;
};
export declare function validateSsoAuthorizationRequest(input: unknown): SsoValidation<SsoAuthorizationRequest>;
export declare function validateSsoIssueCodeRequest(input: unknown): SsoValidation<SsoIssueCodeRequest>;
export declare function validateSsoExchangeRequest(input: unknown): SsoValidation<SsoExchangeRequest>;
export declare function validateSsoCallback(input: unknown): SsoValidation<SsoCallback>;
/**
 * Never legal in a deep-link message, in either direction.
 *
 * The PKCE verifier is on this list deliberately: it is the one secret
 * that must travel ONLY in the direct client→server exchange body. If it
 * ever appeared in a URL, PKCE would provide no protection at all.
 */
export declare const SSO_FORBIDDEN_DEEPLINK_KEYS: readonly string[];
/** True when any forbidden key appears (case-insensitive) at any depth. */
export declare function containsForbiddenSsoField(input: unknown, depth?: number): boolean;
/** The complete, exclusive key set each deep-link message may carry. */
export declare const SSO_AUTHORIZATION_KEYS: readonly string[];
export declare const SSO_CALLBACK_SUCCESS_KEYS: readonly string[];
export declare const SSO_CALLBACK_ERROR_KEYS: readonly string[];
/** No key outside `allowed` is present. */
export declare function hasOnlyKeys(input: unknown, allowed: readonly string[]): boolean;
/**
 * PROVISIONAL, NOT PRODUCTION-APPROVED.
 *
 * The real bound is how long a physical WB-T → WB-S → WB-T app switch
 * takes on the slowest supported device, including a cold WB-S start, the
 * driver reading any confirmation, and the OS returning to WB-T. That has
 * NOT been measured — no device timing exists yet. 120s is a deliberately
 * conservative placeholder: long enough that the first physical trial is
 * unlikely to fail spuriously, short enough that a captured code is not
 * useful for long.
 *
 * See docs/SSO-PROTOCOL.md for the physical test that must set the final
 * value. Do not treat this constant as approved until that test has run.
 */
export declare const SSO_CODE_TTL_MS_PROVISIONAL = 120000;
/**
 * Local pending-attempt lifetime in WB-T. Slightly longer than the server
 * TTL so the SERVER is always the authority that rejects an expired code:
 * if the client expired first it would report "expired" for a code the
 * server would still have honoured, hiding real timing data.
 */
export declare const SSO_ATTEMPT_TTL_MS_PROVISIONAL = 180000;
/** `wellbuilt-suite://sso-authorize?...` — non-secret protocol inputs only. */
export declare function buildSsoAuthorizationUrl(request: SsoAuthorizationRequest): string;
/** `wellbuilt-tickets://sso-callback?...` */
export declare function buildSsoCallbackUrl(callback: SsoCallback): string;
/** Strictly parse the fixed WB-S authorization route. */
export declare function parseSsoAuthorizationUrl(url: unknown): SsoValidation<SsoAuthorizationRequest>;
/** Strictly parse the fixed WB-T callback route. */
export declare function parseSsoCallbackUrl(url: unknown): SsoValidation<SsoCallback>;
//# sourceMappingURL=protocol.d.ts.map