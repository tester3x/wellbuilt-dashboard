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
import { containsForbiddenSsoField, isSsoState } from './protocol.js';
export const JSA_LAUNCH_VERSION = 1;
// ── fixed routes ──────────────────────────────────────────────────────────
// Constants, never client-supplied destinations — same rule as the SSO
// deep links. The launch scheme is WB-JSA's registered scheme; the return
// scheme is WB-T's.
export const JSA_LAUNCH_SCHEME = 'jsaapp';
export const JSA_LAUNCH_HOST = 'start';
export const JSA_RETURN_SCHEME = 'wellbuilt-tickets';
export const JSA_RETURN_HOST = 'jsa-return';
// ── bounded metadata ──────────────────────────────────────────────────────
/** Non-authoritative display hints. Bounded; control characters refused. */
export const JSA_HINT_MAX = 120;
function isBoundedHint(v) {
    return typeof v === 'string'
        && v.length > 0
        && v.length <= JSA_HINT_MAX
        // Control characters (incl. DEL), written as escapes — same refusal
        // rule as normalizeSsoDisplayName.
        && !/[\u0000-\u001F\u007F]/.test(v);
}
/**
 * A launch request id: 43-char base64url, minted fresh by WB-T per launch.
 * Reuses the SSO state shape (256 bits) so correlation is unguessable; it
 * correlates the eventual RETURN with the launch and nothing more — it is
 * not a secret, not identity, and proves nothing by possession.
 */
export const isJsaRequestId = isSsoState;
/**
 * Opaque document references (job doc id / haul-group id shapes). Request
 * metadata only — a ref names WHAT the request is about, never who may
 * act on it, and WB-JSA must verify it against its authenticated binding
 * before any record is scoped by it.
 */
export const JSA_REF_MAX = 128;
function isBoundedRef(v) {
    return typeof v === 'string'
        && v.length > 0
        && v.length <= JSA_REF_MAX
        && /^[A-Za-z0-9._-]+$/.test(v);
}
/** WB-JSA → WB-T over the fixed return route. Status only — no contents. */
export const JSA_RETURN_STATUSES = Object.freeze([
    /** The driver completed the request-bound first read. */
    'read',
    /** The driver acknowledged an existing current JSA. */
    'acknowledged',
    /** The driver backed out without completing. */
    'declined',
    /** WB-JSA could not complete the request (auth/entitlement/shift). */
    'error',
]);
export function isJsaReturnStatus(v) {
    return typeof v === 'string' && JSA_RETURN_STATUSES.includes(v);
}
// ── forbidden material ────────────────────────────────────────────────────
/**
 * Everything the SSO deep links forbid, PLUS the legacy identity fields
 * this contract exists to remove and the SSO protocol fields that belong
 * only on the fixed SSO routes. A launch or return message containing any
 * of these is refused outright — not stripped, not ignored.
 */
export const JSA_FORBIDDEN_LAUNCH_KEYS = Object.freeze([
    'name',
    'displayName',
    'driverId',
    'companyId',
    'shiftId',
    'code',
    'state',
    'codeChallenge',
    'cc',
]);
function containsJsaForbiddenField(o) {
    if (containsForbiddenSsoField(o))
        return true;
    const forbidden = JSA_FORBIDDEN_LAUNCH_KEYS.map((k) => k.toLowerCase());
    return Object.keys(o).some((k) => forbidden.includes(k.toLowerCase()));
}
const LAUNCH_KEYS = Object.freeze([
    'v', 'source', 'requestId', 'returnTo', 'jobRef', 'groupRef', 'wellName', 'jobType',
]);
const RETURN_KEYS = Object.freeze(['v', 'requestId', 'status']);
function rec(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
        ? v
        : null;
}
export function validateJsaLaunchRequest(input) {
    const o = rec(input);
    if (!o)
        return { ok: false, field: '<root>' };
    if (containsJsaForbiddenField(o))
        return { ok: false, field: '<forbidden>' };
    if (!Object.keys(o).every((k) => LAUNCH_KEYS.includes(k))) {
        return { ok: false, field: '<unknown-key>' };
    }
    if (o.v !== JSA_LAUNCH_VERSION)
        return { ok: false, field: 'v' };
    if (o.source !== 'wbt')
        return { ok: false, field: 'source' };
    if (!isJsaRequestId(o.requestId))
        return { ok: false, field: 'requestId' };
    if (o.returnTo !== 'wbt' && o.returnTo !== 'none')
        return { ok: false, field: 'returnTo' };
    if (o.jobRef !== undefined && !isBoundedRef(o.jobRef)) {
        return { ok: false, field: 'jobRef' };
    }
    if (o.groupRef !== undefined && !isBoundedRef(o.groupRef)) {
        return { ok: false, field: 'groupRef' };
    }
    if (o.wellName !== undefined && !isBoundedHint(o.wellName)) {
        return { ok: false, field: 'wellName' };
    }
    if (o.jobType !== undefined && !isBoundedHint(o.jobType)) {
        return { ok: false, field: 'jobType' };
    }
    return {
        ok: true,
        value: {
            v: JSA_LAUNCH_VERSION,
            source: 'wbt',
            requestId: o.requestId,
            returnTo: o.returnTo,
            ...(o.jobRef !== undefined ? { jobRef: o.jobRef } : {}),
            ...(o.groupRef !== undefined ? { groupRef: o.groupRef } : {}),
            ...(o.wellName !== undefined ? { wellName: o.wellName } : {}),
            ...(o.jobType !== undefined ? { jobType: o.jobType } : {}),
        },
    };
}
export function validateJsaReturnMessage(input) {
    const o = rec(input);
    if (!o)
        return { ok: false, field: '<root>' };
    if (containsJsaForbiddenField(o))
        return { ok: false, field: '<forbidden>' };
    if (!Object.keys(o).every((k) => RETURN_KEYS.includes(k))) {
        return { ok: false, field: '<unknown-key>' };
    }
    if (o.v !== JSA_LAUNCH_VERSION)
        return { ok: false, field: 'v' };
    if (!isJsaRequestId(o.requestId))
        return { ok: false, field: 'requestId' };
    if (!isJsaReturnStatus(o.status))
        return { ok: false, field: 'status' };
    return {
        ok: true,
        value: { v: JSA_LAUNCH_VERSION, requestId: o.requestId, status: o.status },
    };
}
// ── deep-link URLs ────────────────────────────────────────────────────────
// Built and parsed HERE so WB-T and WB-JSA share one implementation. The
// parser applies the same strictness rules as the SSO routes: exact host,
// no path/port/userinfo, no fragments, no duplicate keys, bounded length.
// (protocol.ts keeps its parser private; the duplication is deliberate and
// the conformance test asserts the two behave identically on shared cases.)
function enc(v) {
    return encodeURIComponent(v);
}
export function buildJsaLaunchUrl(request) {
    const parts = [
        `v=${enc(String(request.v))}`,
        `source=${enc(request.source)}`,
        `requestId=${enc(request.requestId)}`,
        `returnTo=${enc(request.returnTo)}`,
    ];
    if (request.jobRef !== undefined)
        parts.push(`jobRef=${enc(request.jobRef)}`);
    if (request.groupRef !== undefined)
        parts.push(`groupRef=${enc(request.groupRef)}`);
    if (request.wellName !== undefined)
        parts.push(`wellName=${enc(request.wellName)}`);
    if (request.jobType !== undefined)
        parts.push(`jobType=${enc(request.jobType)}`);
    return `${JSA_LAUNCH_SCHEME}://${JSA_LAUNCH_HOST}?${parts.join('&')}`;
}
export function buildJsaReturnUrl(message) {
    const q = [
        `v=${enc(String(message.v))}`,
        `requestId=${enc(message.requestId)}`,
        `status=${enc(message.status)}`,
    ].join('&');
    return `${JSA_RETURN_SCHEME}://${JSA_RETURN_HOST}?${q}`;
}
function splitDeepLink(url, scheme, host) {
    if (typeof url !== 'string' || url.length > 2048)
        return null;
    const prefix = `${scheme}://`;
    if (!url.startsWith(prefix))
        return null;
    const rest = url.slice(prefix.length);
    const qAt = rest.indexOf('?');
    const hostPart = qAt < 0 ? rest : rest.slice(0, qAt);
    if (hostPart !== host)
        return null;
    if (qAt < 0)
        return {};
    const query = rest.slice(qAt + 1);
    if (query.includes('#'))
        return null;
    const out = {};
    for (const pair of query.split('&')) {
        if (!pair)
            continue;
        const eq = pair.indexOf('=');
        if (eq < 0)
            return null;
        const k = pair.slice(0, eq);
        let v;
        try {
            v = decodeURIComponent(pair.slice(eq + 1));
        }
        catch {
            return null;
        }
        if (Object.prototype.hasOwnProperty.call(out, k))
            return null;
        out[k] = v;
    }
    return out;
}
/**
 * Strictly parse the fixed launch route. A LEGACY launch (hash/name
 * params) parses as a refusal, never as a degraded success — the caller
 * shows its ordinary authenticated start, not a launch-derived session.
 */
export function parseJsaLaunchUrl(url) {
    const q = splitDeepLink(url, JSA_LAUNCH_SCHEME, JSA_LAUNCH_HOST);
    if (!q)
        return { ok: false, field: '<url>' };
    const version = Number(q.v);
    return validateJsaLaunchRequest({
        ...q,
        v: Number.isFinite(version) ? version : q.v,
    });
}
export function parseJsaReturnUrl(url) {
    const q = splitDeepLink(url, JSA_RETURN_SCHEME, JSA_RETURN_HOST);
    if (!q)
        return { ok: false, field: '<url>' };
    const version = Number(q.v);
    return validateJsaReturnMessage({
        ...q,
        v: Number.isFinite(version) ? version : q.v,
    });
}
//# sourceMappingURL=jsaLaunch.js.map