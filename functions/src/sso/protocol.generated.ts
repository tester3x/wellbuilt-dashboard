/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Verbatim copy of the canonical SSO protocol from
 * @tester3x/wellbuilt-contracts src/sso/protocol.ts at version
 * 0.3.0-dev.0 (UNPUBLISHED).
 *
 * Regenerate:  node tools/mirror-sso-protocol.mjs --regenerate
 * Verify:      node tools/mirror-sso-protocol.mjs --verify
 *
 * This exists only because the contracts package mirror is SHA-pinned to
 * the published 0.2.0 artifact and cannot carry an unpublished bump.
 * When the SSO protocol is published, delete this file and import from
 * the package instead.
 */
// @generated from wellbuilt-contracts/src/sso/protocol.ts
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

export const SSO_PROTOCOL_VERSION = 1 as const;
export type SsoProtocolVersion = typeof SSO_PROTOCOL_VERSION;
export const SUPPORTED_SSO_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([
  SSO_PROTOCOL_VERSION,
]);

/** Fail closed on any unknown/future protocol version. */
export function assertSsoProtocolCompatible(version: number, consumerName: string): void {
  if (!SUPPORTED_SSO_PROTOCOL_VERSIONS.includes(version)) {
    throw new Error(
      `[@tester3x/wellbuilt-contracts] ${consumerName} cannot consume SSO protocol version ` +
      `${version}; supported: ${SUPPORTED_SSO_PROTOCOL_VERSIONS.join(', ')}`,
    );
  }
}

export function isSsoProtocolVersion(v: unknown): v is SsoProtocolVersion {
  return v === SSO_PROTOCOL_VERSION;
}

// ── audience ──────────────────────────────────────────────────────────────

/** The only audience this protocol version issues codes for. */
export const SSO_AUDIENCE_WBT = 'wellbuilt-tickets' as const;
/**
 * vc51.9AE — WB eQuipment. Added because eQuipment's DVIR handoff
 * previously carried a passcode-derived hash in its launch URI and treated
 * possession of it as identity. It joins the same authorization-code
 * exchange rather than getting a parallel protocol.
 */
export const SSO_AUDIENCE_EQUIPMENT = 'wellbuilt-equipment' as const;
export type SsoAudience = typeof SSO_AUDIENCE_WBT | typeof SSO_AUDIENCE_EQUIPMENT;
export const SSO_AUDIENCES: readonly SsoAudience[] = Object.freeze([
  SSO_AUDIENCE_WBT,
  SSO_AUDIENCE_EQUIPMENT,
]);

export function isSsoAudience(v: unknown): v is SsoAudience {
  return typeof v === 'string' && (SSO_AUDIENCES as readonly string[]).includes(v);
}

/**
 * Per-session claim naming the application a token was minted for.
 *
 * Rides in the custom token's developer claims, NOT in setCustomUserClaims:
 * persisted claims live on the Auth USER and are shared by every app, so
 * writing an app marker there would corrupt WB-S's own session. Developer
 * claims are per-token and expire with it.
 */
export const SSO_SESSION_APP_CLAIM = 'app' as const;
export const SSO_SESSION_APP_WBT = 'wbt' as const;
export const SSO_SESSION_APP_EQUIPMENT = 'equipment' as const;

/**
 * Audience → per-session app claim. A map rather than a conditional so a
 * new audience cannot be added without deciding what it is called in the
 * minted token.
 */
export const SSO_SESSION_APP_BY_AUDIENCE: Readonly<Record<SsoAudience, string>> = Object.freeze({
  [SSO_AUDIENCE_WBT]: SSO_SESSION_APP_WBT,
  [SSO_AUDIENCE_EQUIPMENT]: SSO_SESSION_APP_EQUIPMENT,
});

// ── PKCE ──────────────────────────────────────────────────────────────────

/** Only S256. `plain` is never acceptable. */
export const SSO_CHALLENGE_METHOD = 'S256' as const;
export type SsoChallengeMethod = typeof SSO_CHALLENGE_METHOD;

export function isSsoChallengeMethod(v: unknown): v is SsoChallengeMethod {
  return v === SSO_CHALLENGE_METHOD;
}

// ── sizes and encodings ───────────────────────────────────────────────────

/** Every protocol secret is 256 bits. Nothing weaker is representable. */
export const SSO_STATE_BYTES = 32;
export const SSO_VERIFIER_BYTES = 32;
export const SSO_CODE_BYTES = 32;

/** base64url of exactly 32 bytes, unpadded. */
export const SSO_B64URL_32_LENGTH = 43;

/**
 * Patterns are exported as STRINGS, never as RegExp singletons.
 *
 * A frozen RegExp with the `g` or `y` flag throws on its second `.test()`
 * because it cannot write `lastIndex`; exporting the source avoids
 * handing consumers any shared mutable matcher at all.
 */
export const SSO_STATE_PATTERN = `^[A-Za-z0-9_-]{${SSO_B64URL_32_LENGTH}}$`;
export const SSO_CODE_PATTERN = `^[A-Za-z0-9_-]{${SSO_B64URL_32_LENGTH}}$`;
export const SSO_CHALLENGE_PATTERN = `^[A-Za-z0-9_-]{${SSO_B64URL_32_LENGTH}}$`;
/**
 * RFC 7636 §4.1 code verifier: 43–128 characters of the unreserved set
 * ALPHA / DIGIT / "-" / "." / "_" / "~". We always mint exactly 43
 * (base64url of 256 bits) but accept the full legal range so a future
 * client is not locked out by our own generator's choice.
 */
export const SSO_VERIFIER_PATTERN = '^[A-Za-z0-9\\-._~]{43,128}$';

/**
 * Matchers are built PER CALL, never held at module scope.
 *
 * A shared RegExp is mutable state: with `g`/`y` it carries `lastIndex`
 * between callers, and if the module object is frozen the write throws on
 * the second `.test()`. Constructing on demand costs nothing measurable
 * here and removes the whole class of defect.
 */
function matches(pattern: string, v: unknown): v is string {
  return typeof v === 'string' && new RegExp(pattern).test(v);
}

export function isSsoState(v: unknown): v is string {
  return matches(SSO_STATE_PATTERN, v);
}
export function isSsoCode(v: unknown): v is string {
  return matches(SSO_CODE_PATTERN, v);
}
export function isSsoChallenge(v: unknown): v is string {
  return matches(SSO_CHALLENGE_PATTERN, v);
}
export function isSsoVerifier(v: unknown): v is string {
  return matches(SSO_VERIFIER_PATTERN, v);
}

// ── fixed routes ──────────────────────────────────────────────────────────
// Fixed identities, NOT arbitrary redirect URIs. The callback destination
// is a protocol constant so a malicious authorization request cannot
// redirect the code anywhere. Nothing in any message names a URL.

export const SSO_AUTHORIZE_SCHEME = 'wellbuilt-suite' as const;
export const SSO_AUTHORIZE_HOST = 'sso-authorize' as const;
export const SSO_CALLBACK_SCHEME = 'wellbuilt-tickets' as const;
export const SSO_CALLBACK_HOST = 'sso-callback' as const;

/** vc51.9AE — eQuipment's fixed callback identity. Same host, own scheme. */
export const SSO_CALLBACK_SCHEME_EQUIPMENT = 'wbequipment' as const;

/**
 * Audience → fixed callback route. Still constants, never a client-supplied
 * redirect URI: the destination is chosen by the audience the code was
 * issued for, so a code cannot be steered to a different application.
 */
export const SSO_CALLBACK_BY_AUDIENCE: Readonly<
  Record<SsoAudience, { scheme: string; host: string }>
> = Object.freeze({
  [SSO_AUDIENCE_WBT]: Object.freeze({ scheme: SSO_CALLBACK_SCHEME, host: SSO_CALLBACK_HOST }),
  [SSO_AUDIENCE_EQUIPMENT]: Object.freeze({
    scheme: SSO_CALLBACK_SCHEME_EQUIPMENT,
    host: SSO_CALLBACK_HOST,
  }),
});

// ── DVIR shift binding (equipment audience only) ──────────────────────────

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
const SSO_DVIR_PHASES_INTERNAL: readonly SsoDvirPhase[] = Object.freeze(['pre_trip', 'post_trip']);

function isPhase(v: unknown): v is SsoDvirPhase {
  return typeof v === 'string' && (SSO_DVIR_PHASES_INTERNAL as readonly string[]).includes(v);
}

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

export const SSO_SHIFT_ID_MAX = 128;

export function isSsoShiftBinding(v: unknown): v is SsoShiftBinding {
  const o = v as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes('shiftId') || !keys.includes('phase')) return false;
  return typeof o.shiftId === 'string'
    && o.shiftId.length > 0
    && o.shiftId.length <= SSO_SHIFT_ID_MAX
    && isPhase(o.phase);
}

/** Shift binding is mandatory for equipment and forbidden for every other audience. */
export function audienceRequiresShiftBinding(audience: SsoAudience): boolean {
  return audience === SSO_AUDIENCE_EQUIPMENT;
}

/** Upper bound on an authoritative display name carried in a response. */
export const SSO_DISPLAY_NAME_MAX = 120;

/**
 * The tickets app persists a local identity and therefore needs a name;
 * no other audience does. Keeping this a predicate rather than an inline
 * comparison means the server and the client cannot disagree about which
 * audiences carry the field.
 */
export function audienceCarriesDisplayName(audience: SsoAudience): boolean {
  return audience === SSO_AUDIENCE_WBT;
}

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
export function normalizeSsoDisplayName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // Control characters, including DEL. Written as escapes, never literal
  // bytes, so the rule survives copy, diff and the verbatim source mirror.
  if (/[\u0000-\u001F\u007F]/.test(v)) return null;
  const collapsed = v.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0 || collapsed.length > SSO_DISPLAY_NAME_MAX) return null;
  return collapsed;
}

// ── error codes ───────────────────────────────────────────────────────────
// Deliberately coarse. A caller must not be able to tell "no such code"
// from "wrong verifier" from "already consumed".

export const SSO_ERROR_CODES = Object.freeze([
  'unsupported_protocol',
  'unsupported_audience',
  'unsupported_method',
  'malformed_request',
  /** WB-S has no verified session it can vouch for. */
  'not_authorized',
  /** WB-S is local-only / offline; WB-T should offer manual login. */
  'unavailable',
  /** The authorization was abandoned: logout or identity change. */
  'superseded',
  /** Generic terminal exchange failure. Never distinguishes the cause. */
  'invalid_grant',
] as const);
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

export function isSsoErrorCode(v: unknown): v is SsoErrorCode {
  return typeof v === 'string' && (SSO_ERROR_CODES as readonly string[]).includes(v);
}

// ── messages ──────────────────────────────────────────────────────────────

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
export type SsoCallback =
  | {
      protocolVersion: number;
      status: 'success';
      code: string;
      state: string;
    }
  | {
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

// ── validation ────────────────────────────────────────────────────────────

export type SsoValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errorCode: SsoErrorCode; field: string };

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function checkEnvelope(
  o: Record<string, unknown>,
): { errorCode: SsoErrorCode; field: string } | null {
  if (!isSsoProtocolVersion(o.protocolVersion)) {
    return { errorCode: 'unsupported_protocol', field: 'protocolVersion' };
  }
  if (!isSsoAudience(o.audience)) {
    return { errorCode: 'unsupported_audience', field: 'audience' };
  }
  return null;
}

export function validateSsoAuthorizationRequest(
  input: unknown,
): SsoValidation<SsoAuthorizationRequest> {
  const o = rec(input);
  if (!o) return { ok: false, errorCode: 'malformed_request', field: '<root>' };
  const bad = checkEnvelope(o);
  if (bad) return { ok: false, ...bad };
  if (!isSsoChallengeMethod(o.codeChallengeMethod)) {
    return { ok: false, errorCode: 'unsupported_method', field: 'codeChallengeMethod' };
  }
  if (!isSsoChallenge(o.codeChallenge)) {
    return { ok: false, errorCode: 'malformed_request', field: 'codeChallenge' };
  }
  if (!isSsoState(o.state)) {
    return { ok: false, errorCode: 'malformed_request', field: 'state' };
  }
  return {
    ok: true,
    value: {
      protocolVersion: SSO_PROTOCOL_VERSION,
      audience: o.audience as SsoAudience,
      codeChallenge: o.codeChallenge,
      codeChallengeMethod: SSO_CHALLENGE_METHOD,
      state: o.state,
    },
  };
}

export function validateSsoIssueCodeRequest(input: unknown): SsoValidation<SsoIssueCodeRequest> {
  const o = rec(input);
  if (!o) return { ok: false, errorCode: 'malformed_request', field: '<root>' };
  const bad = checkEnvelope(o);
  if (bad) return { ok: false, ...bad };
  if (!isSsoChallengeMethod(o.codeChallengeMethod)) {
    return { ok: false, errorCode: 'unsupported_method', field: 'codeChallengeMethod' };
  }
  if (!isSsoChallenge(o.codeChallenge)) {
    return { ok: false, errorCode: 'malformed_request', field: 'codeChallenge' };
  }
  // vc51.9AE — shift binding is exactly-required for equipment and exactly
  // -forbidden elsewhere. Both directions are enforced so WB-T cannot start
  // smuggling a binding, and an equipment request cannot omit one and be
  // silently bound to nothing.
  const audience = o.audience as SsoAudience;
  const needsBinding = audienceRequiresShiftBinding(audience);
  if (needsBinding && !isSsoShiftBinding(o.shiftBinding)) {
    return { ok: false, errorCode: 'malformed_request', field: 'shiftBinding' };
  }
  if (!needsBinding && o.shiftBinding !== undefined) {
    return { ok: false, errorCode: 'malformed_request', field: 'shiftBinding' };
  }
  return {
    ok: true,
    value: {
      protocolVersion: SSO_PROTOCOL_VERSION,
      audience,
      codeChallenge: o.codeChallenge,
      codeChallengeMethod: SSO_CHALLENGE_METHOD,
      ...(needsBinding ? { shiftBinding: o.shiftBinding as SsoShiftBinding } : {}),
    },
  };
}

export function validateSsoExchangeRequest(input: unknown): SsoValidation<SsoExchangeRequest> {
  const o = rec(input);
  if (!o) return { ok: false, errorCode: 'malformed_request', field: '<root>' };
  const bad = checkEnvelope(o);
  if (bad) return { ok: false, ...bad };
  if (!isSsoCode(o.code)) {
    return { ok: false, errorCode: 'malformed_request', field: 'code' };
  }
  if (!isSsoVerifier(o.codeVerifier)) {
    return { ok: false, errorCode: 'malformed_request', field: 'codeVerifier' };
  }
  return {
    ok: true,
    value: {
      protocolVersion: SSO_PROTOCOL_VERSION,
      audience: o.audience as SsoAudience,
      code: o.code,
      codeVerifier: o.codeVerifier,
    },
  };
}

export function validateSsoCallback(input: unknown): SsoValidation<SsoCallback> {
  const o = rec(input);
  if (!o) return { ok: false, errorCode: 'malformed_request', field: '<root>' };
  if (!isSsoProtocolVersion(o.protocolVersion)) {
    return { ok: false, errorCode: 'unsupported_protocol', field: 'protocolVersion' };
  }
  if (o.status === 'success') {
    if (!isSsoCode(o.code)) return { ok: false, errorCode: 'malformed_request', field: 'code' };
    if (!isSsoState(o.state)) return { ok: false, errorCode: 'malformed_request', field: 'state' };
    return {
      ok: true,
      value: {
        protocolVersion: SSO_PROTOCOL_VERSION,
        status: 'success',
        code: o.code,
        state: o.state,
      },
    };
  }
  if (o.status === 'error') {
    if (!isSsoErrorCode(o.errorCode)) {
      return { ok: false, errorCode: 'malformed_request', field: 'errorCode' };
    }
    const value: SsoCallback = {
      protocolVersion: SSO_PROTOCOL_VERSION,
      status: 'error',
      errorCode: o.errorCode,
    };
    if (isSsoState(o.state)) value.state = o.state;
    return { ok: true, value };
  }
  return { ok: false, errorCode: 'malformed_request', field: 'status' };
}

// ── forbidden payload guard ───────────────────────────────────────────────

/**
 * Never legal in a deep-link message, in either direction.
 *
 * The PKCE verifier is on this list deliberately: it is the one secret
 * that must travel ONLY in the direct client→server exchange body. If it
 * ever appeared in a URL, PKCE would provide no protection at all.
 */
export const SSO_FORBIDDEN_DEEPLINK_KEYS: readonly string[] = Object.freeze([
  'idToken',
  'id_token',
  'refreshToken',
  'refresh_token',
  'customToken',
  'custom_token',
  'accessToken',
  'access_token',
  'passcode',
  'password',
  'hash',
  'driverHash',
  'passcodeHash',
  'codeVerifier',
  'code_verifier',
  'verifier',
]);

/** True when any forbidden key appears (case-insensitive) at any depth. */
export function containsForbiddenSsoField(input: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  const o = rec(input);
  if (!o) return false;
  const forbidden = SSO_FORBIDDEN_DEEPLINK_KEYS.map((k) => k.toLowerCase());
  for (const key of Object.keys(o)) {
    if (forbidden.includes(key.toLowerCase())) return true;
    if (containsForbiddenSsoField(o[key], depth + 1)) return true;
  }
  return false;
}

/** The complete, exclusive key set each deep-link message may carry. */
export const SSO_AUTHORIZATION_KEYS: readonly string[] = Object.freeze([
  'protocolVersion',
  'audience',
  'codeChallenge',
  'codeChallengeMethod',
  'state',
]);
export const SSO_CALLBACK_SUCCESS_KEYS: readonly string[] = Object.freeze([
  'protocolVersion',
  'status',
  'code',
  'state',
]);
export const SSO_CALLBACK_ERROR_KEYS: readonly string[] = Object.freeze([
  'protocolVersion',
  'status',
  'errorCode',
  'state',
]);

/** No key outside `allowed` is present. */
export function hasOnlyKeys(input: unknown, allowed: readonly string[]): boolean {
  const o = rec(input);
  if (!o) return false;
  return Object.keys(o).every((k) => allowed.includes(k));
}

// ── provisional TTL ───────────────────────────────────────────────────────

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
export const SSO_CODE_TTL_MS_PROVISIONAL = 120_000;

/**
 * Local pending-attempt lifetime in WB-T. Slightly longer than the server
 * TTL so the SERVER is always the authority that rejects an expired code:
 * if the client expired first it would report "expired" for a code the
 * server would still have honoured, hiding real timing data.
 */
export const SSO_ATTEMPT_TTL_MS_PROVISIONAL = 180_000;

// ── deep-link URLs ────────────────────────────────────────────────────────
// Built and parsed HERE so both apps share one implementation. The scheme
// and host are protocol constants: a message never names a destination,
// so there is no redirect to inject.

function enc(v: string): string {
  return encodeURIComponent(v);
}

/** `wellbuilt-suite://sso-authorize?...` — non-secret protocol inputs only. */
export function buildSsoAuthorizationUrl(request: SsoAuthorizationRequest): string {
  const q = [
    `v=${enc(String(request.protocolVersion))}`,
    `aud=${enc(request.audience)}`,
    `cc=${enc(request.codeChallenge)}`,
    `ccm=${enc(request.codeChallengeMethod)}`,
    `state=${enc(request.state)}`,
  ].join('&');
  return `${SSO_AUTHORIZE_SCHEME}://${SSO_AUTHORIZE_HOST}?${q}`;
}

/** `wellbuilt-tickets://sso-callback?...` */
export function buildSsoCallbackUrl(callback: SsoCallback): string {
  const parts = [`v=${enc(String(callback.protocolVersion))}`, `status=${enc(callback.status)}`];
  if (callback.status === 'success') {
    parts.push(`code=${enc(callback.code)}`, `state=${enc(callback.state)}`);
  } else {
    parts.push(`err=${enc(callback.errorCode)}`);
    if (callback.state) parts.push(`state=${enc(callback.state)}`);
  }
  return `${SSO_CALLBACK_SCHEME}://${SSO_CALLBACK_HOST}?${parts.join('&')}`;
}

/**
 * Split a deep link into scheme, host, and query pairs.
 *
 * Hand-rolled rather than using URL: React Native's URL polyfill does not
 * treat custom schemes consistently, and this must behave identically on
 * both platforms and in node tests. Rejects anything with a path segment,
 * userinfo, or port — none are legal here, and accepting them would widen
 * what "the fixed route" means.
 */
function splitDeepLink(
  url: unknown,
  scheme: string,
  host: string,
): Record<string, string> | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const prefix = `${scheme}://`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const qAt = rest.indexOf('?');
  const hostPart = qAt < 0 ? rest : rest.slice(0, qAt);
  // Exact host, nothing else. No path, no port, no credentials.
  if (hostPart !== host) return null;
  if (qAt < 0) return {};
  const query = rest.slice(qAt + 1);
  if (query.includes('#')) return null;
  const out: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) return null;
    const k = pair.slice(0, eq);
    let v: string;
    try {
      v = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return null; // malformed percent-encoding
    }
    // Duplicate keys are a smuggling vector: one parser may take the
    // first and another the last. Refuse instead of choosing.
    if (Object.prototype.hasOwnProperty.call(out, k)) return null;
    out[k] = v;
  }
  return out;
}

/** Strictly parse the fixed WB-S authorization route. */
export function parseSsoAuthorizationUrl(url: unknown): SsoValidation<SsoAuthorizationRequest> {
  const q = splitDeepLink(url, SSO_AUTHORIZE_SCHEME, SSO_AUTHORIZE_HOST);
  if (!q) return { ok: false, errorCode: 'malformed_request', field: '<url>' };
  const version = Number(q.v);
  return validateSsoAuthorizationRequest({
    protocolVersion: Number.isFinite(version) ? version : q.v,
    audience: q.aud,
    codeChallenge: q.cc,
    codeChallengeMethod: q.ccm,
    state: q.state,
  });
}

/** Strictly parse the fixed WB-T callback route. */
export function parseSsoCallbackUrl(url: unknown): SsoValidation<SsoCallback> {
  const q = splitDeepLink(url, SSO_CALLBACK_SCHEME, SSO_CALLBACK_HOST);
  if (!q) return { ok: false, errorCode: 'malformed_request', field: '<url>' };
  const version = Number(q.v);
  const base: Record<string, unknown> = {
    protocolVersion: Number.isFinite(version) ? version : q.v,
    status: q.status,
  };
  if (q.status === 'success') {
    base.code = q.code;
    base.state = q.state;
  } else {
    base.errorCode = q.err;
    if (q.state !== undefined) base.state = q.state;
  }
  return validateSsoCallback(base);
}
