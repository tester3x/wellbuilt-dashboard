/**
 * Governed WB-T → WB-JSA launch and return contract.
 *
 * REPLACES the legacy `jsaapp://start?hash=…&name=…` launch, in which the
 * receiving app treated possession of a passcode-derived hash and a display
 * name as proof of identity. That is how WB-JSA vc5 reused a stale legacy
 * session and a June shift during an active August one.
 *
 * THE LAUNCH LINK CARRIES NO AUTHORITY. It is a REQUEST: "the driver in
 * WB-T would like to complete a JSA read for this job context." Identity,
 * company, shift state, plan entitlement, and JSA policy all come from the
 * governed authentication WB-JSA performs AFTER launch (SSO authorization-
 * code exchange via Suite, or its own persisted secure session), and any
 * job context named here must be verified against that authenticated
 * binding before it scopes anything. A launch URI can be logged, spoofed,
 * or replayed by any app registering the scheme — so nothing in it may be
 * trusted, and nothing in it needs to be.
 *
 * THE RETURN LINK CARRIES NO RECEIPT CONTENT. WB-T learns only that the
 * request it issued reached a terminal status; the JSA record itself stays
 *  in the governed backend, and WB-T re-reads acknowledgment state through
 * its existing authenticated path.
 *
 * Pure and node-testable: no runtime imports beyond ./protocol (itself
 * pure), no platform APIs, no randomness, no clock.
 */
import { isSsoState } from './protocol.js';
export declare const JSA_LAUNCH_VERSION: 1;
export declare const JSA_LAUNCH_SCHEME: "jsaapp";
export declare const JSA_LAUNCH_HOST: "start";
export declare const JSA_RETURN_SCHEME: "wellbuilt-tickets";
export declare const JSA_RETURN_HOST: "jsa-return";
/** Non-authoritative display hints. Bounded; control characters refused. */
export declare const JSA_HINT_MAX = 120;
/**
 * A launch request id: 43-char base64url, minted fresh by WB-T per launch.
 * Reuses the SSO state shape (256 bits) so correlation is unguessable; it
 * correlates the eventual RETURN with the launch and nothing more — it is
 * not a secret, not identity, and proves nothing by possession.
 */
export declare const isJsaRequestId: typeof isSsoState;
export type JsaReturnTarget = 'wbt' | 'none';
/**
 * Opaque document references (job doc id / haul-group id shapes). Request
 * metadata only — a ref names WHAT the request is about, never who may
 * act on it, and WB-JSA must verify it against its authenticated binding
 * before any record is scoped by it.
 */
export declare const JSA_REF_MAX = 128;
/**
 * WB-T → WB-JSA over the fixed launch route. Bounded request/return
 * metadata ONLY:
 *  - requestId  — correlation for the return link;
 *  - returnTo   — whether a return link is expected at all;
 *  - wellName / jobType — display hints for the JSA form. NEVER authority:
 *    WB-JSA must verify any job context against its authenticated binding
 *    before a record is scoped by it.
 *
 * Deliberately ABSENT, forever: name, hash, passcode, tokens,
 * authorization codes, PKCE material, driver/company ids, shift ids. The
 * shift a JSA binds to comes exclusively from the server-authored
 * SsoJsaBinding on the authenticated exchange.
 */
export interface JsaLaunchRequest {
    v: number;
    source: 'wbt';
    requestId: string;
    returnTo: JsaReturnTarget;
    /** Opaque job document reference the read request is bound to. */
    jobRef?: string;
    /** Opaque haul-group reference for multi-load jobs. */
    groupRef?: string;
    wellName?: string;
    jobType?: string;
}
/** WB-JSA → WB-T over the fixed return route. Status only — no contents. */
export declare const JSA_RETURN_STATUSES: readonly ["read", "acknowledged", "declined", "error"];
export type JsaReturnStatus = (typeof JSA_RETURN_STATUSES)[number];
export declare function isJsaReturnStatus(v: unknown): v is JsaReturnStatus;
export interface JsaReturnMessage {
    v: number;
    requestId: string;
    status: JsaReturnStatus;
}
/**
 * Everything the SSO deep links forbid, PLUS the legacy identity fields
 * this contract exists to remove and the SSO protocol fields that belong
 * only on the fixed SSO routes. A launch or return message containing any
 * of these is refused outright — not stripped, not ignored.
 */
export declare const JSA_FORBIDDEN_LAUNCH_KEYS: readonly string[];
export type JsaLaunchValidation<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    field: string;
};
export declare function validateJsaLaunchRequest(input: unknown): JsaLaunchValidation<JsaLaunchRequest>;
export declare function validateJsaReturnMessage(input: unknown): JsaLaunchValidation<JsaReturnMessage>;
export declare function buildJsaLaunchUrl(request: JsaLaunchRequest): string;
export declare function buildJsaReturnUrl(message: JsaReturnMessage): string;
/**
 * Strictly parse the fixed launch route. A LEGACY launch (hash/name
 * params) parses as a refusal, never as a degraded success — the caller
 * shows its ordinary authenticated start, not a launch-derived session.
 */
export declare function parseJsaLaunchUrl(url: unknown): JsaLaunchValidation<JsaLaunchRequest>;
export declare function parseJsaReturnUrl(url: unknown): JsaLaunchValidation<JsaReturnMessage>;
//# sourceMappingURL=jsaLaunch.d.ts.map