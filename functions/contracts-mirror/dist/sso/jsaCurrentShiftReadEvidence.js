/**
 * Read-only current-shift JSA read-bootstrap evidence.
 *
 * WB-T's start gate must not re-force a first-of-shift Read JSA after a
 * governed completion already attested a full read in the OPEN period.
 * The client cannot list governed records, and it must not be trusted
 * with company/driver/period authority. This contract is the empty
 * request + bounded response the server answers from:
 *
 *   authenticated identity + driver_shift_authority.openPeriodId
 *   + governed completions whose terminal action includes a read.
 *
 * ADDITIVE. Independent protocol version. No identity, requestId, jobRef,
 * action, name, or signature may ride the response.
 */
import { hasOnlyKeys, SSO_JSA_PERIOD_ID_PATTERN } from './protocol.js';
export const JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION = 1;
export const SUPPORTED_JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSIONS = Object.freeze([JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION]);
export function isJsaCurrentShiftReadEvidenceProtocolVersion(v) {
    return v === JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION;
}
/**
 * Terminal actions that attest a completed FULL READ.
 *
 * Canonical, single list. Acknowledge-only never qualifies. Shared so the
 * server lookup and WB-T's consume adapter cannot drift.
 */
export const JSA_READ_EVIDENCE_ACTIONS = Object.freeze([
    'read_completed',
    'read_and_acknowledged',
]);
export function isJsaReadEvidenceAction(v) {
    return v === 'read_completed' || v === 'read_and_acknowledged';
}
/** True when the terminal action attests a completed full read. */
export function terminalActionIncludesRead(action) {
    return isJsaReadEvidenceAction(action);
}
export const JSA_CURRENT_SHIFT_READ_EVIDENCE_STATES = Object.freeze([
    'read_bootstrapped',
    'none',
    'no_active_shift',
]);
export function isJsaCurrentShiftReadEvidenceState(v) {
    return (v === 'read_bootstrapped' || v === 'none' || v === 'no_active_shift');
}
/** The request may carry ONLY protocolVersion. */
export const JSA_CURRENT_SHIFT_READ_EVIDENCE_REQUEST_KEYS = Object.freeze([
    'protocolVersion',
]);
/**
 * Fields that MUST NEVER be accepted as request authority. Presence is
 * a hard refuse — they are not ignored after parse, so a hostile client
 * cannot probe whether the server would have used them.
 */
export const JSA_CURRENT_SHIFT_READ_EVIDENCE_FORBIDDEN_REQUEST_KEYS = Object.freeze([
    'companyId',
    'driverId',
    'driverHash',
    'uid',
    'shiftId',
    'periodId',
    'openPeriodId',
    'originLocalDate',
    'requestId',
    'jobRef',
    'groupRef',
    'ticket',
    'ticketNumber',
    'name',
    'displayName',
    'legalName',
    'hash',
    'passcode',
]);
export const JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_BOOTSTRAPPED_KEYS = Object.freeze([
    'protocolVersion',
    'state',
    'periodId',
]);
export const JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_NONE_KEYS = JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_BOOTSTRAPPED_KEYS;
export const JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_NO_SHIFT_KEYS = Object.freeze([
    'protocolVersion',
    'state',
]);
export const JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_FORBIDDEN_KEYS = Object.freeze([
    'requestId',
    'jobRef',
    'groupRef',
    'action',
    'intent',
    'name',
    'displayName',
    'legalName',
    'signature',
    'dataBase64',
    'storagePath',
]);
function rec(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
        ? v
        : null;
}
function matches(pattern, v) {
    return typeof v === 'string' && new RegExp(`^${pattern}$`).test(v);
}
function isPeriodId(v) {
    return matches(SSO_JSA_PERIOD_ID_PATTERN, v);
}
export function validateJsaCurrentShiftReadEvidenceRequest(input) {
    const o = rec(input);
    if (!o)
        return { ok: false, errorCode: 'malformed_request', field: 'root' };
    const keys = Object.keys(o);
    for (const k of keys) {
        if (JSA_CURRENT_SHIFT_READ_EVIDENCE_FORBIDDEN_REQUEST_KEYS.includes(k)) {
            return { ok: false, errorCode: 'client_identity', field: k };
        }
    }
    if (!hasOnlyKeys(o, JSA_CURRENT_SHIFT_READ_EVIDENCE_REQUEST_KEYS)) {
        return { ok: false, errorCode: 'malformed_request', field: 'unknown_key' };
    }
    if (typeof o.protocolVersion !== 'number') {
        return { ok: false, errorCode: 'malformed_request', field: 'protocolVersion' };
    }
    if (o.protocolVersion !== JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION) {
        return { ok: false, errorCode: 'unsupported_protocol', field: 'protocolVersion' };
    }
    return {
        ok: true,
        value: { protocolVersion: JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION },
    };
}
export function validateJsaCurrentShiftReadEvidenceResponse(input) {
    const o = rec(input);
    if (!o)
        return { ok: false, errorCode: 'malformed_request', field: 'root' };
    for (const k of Object.keys(o)) {
        if (JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_FORBIDDEN_KEYS.includes(k)) {
            return { ok: false, errorCode: 'malformed_request', field: k };
        }
    }
    if (o.protocolVersion !== JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION) {
        return { ok: false, errorCode: 'unsupported_protocol', field: 'protocolVersion' };
    }
    if (!isJsaCurrentShiftReadEvidenceState(o.state)) {
        return { ok: false, errorCode: 'malformed_request', field: 'state' };
    }
    if (o.state === 'no_active_shift') {
        if (!hasOnlyKeys(o, JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_NO_SHIFT_KEYS)) {
            return { ok: false, errorCode: 'malformed_request', field: 'unknown_key' };
        }
        return {
            ok: true,
            value: {
                protocolVersion: JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION,
                state: 'no_active_shift',
            },
        };
    }
    if (!hasOnlyKeys(o, JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_BOOTSTRAPPED_KEYS)) {
        return { ok: false, errorCode: 'malformed_request', field: 'unknown_key' };
    }
    if (!isPeriodId(o.periodId)) {
        return { ok: false, errorCode: 'malformed_request', field: 'periodId' };
    }
    return {
        ok: true,
        value: {
            protocolVersion: JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION,
            state: o.state,
            periodId: o.periodId,
        },
    };
}
/**
 * Pure decision over already-fetched records. Does not talk to storage.
 * A matching completed read-bearing action → read_bootstrapped.
 * Otherwise none. Callers map "no open period" to no_active_shift
 * BEFORE invoking this — an unverifiable authority must never reach
 * here as an empty list (that would degrade to none).
 */
export function decideCurrentShiftReadEvidence(periodId, records, expect) {
    if (!isPeriodId(periodId) || !expect.companyId || !expect.driverId)
        return 'none';
    for (const r of records) {
        if (r.companyId !== expect.companyId)
            continue;
        if (r.driverId !== expect.driverId)
            continue;
        if (r.bindingPeriodId !== periodId)
            continue;
        if (r.state !== 'completed')
            continue;
        if (!terminalActionIncludesRead(r.action))
            continue;
        return 'read_bootstrapped';
    }
    return 'none';
}
//# sourceMappingURL=jsaCurrentShiftReadEvidence.js.map