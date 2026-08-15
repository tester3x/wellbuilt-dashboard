/**
 * Governed per-job acknowledgment after a completed first-read.
 *
 * Ordinary Acknowledge must not clone a legacy `jsas` template. WB-T
 * sends only jobRef (plus optional attested observation metadata).
 * Identity, period, and qualifying read evidence are server-derived.
 *
 * ADDITIVE. Independent protocol version. Response carries only
 * protocolVersion + state. No jobRef, periodId, requestId, action,
 * identity, or JSA content.
 */
import { hasOnlyKeys } from './protocol.js';
import { JSA_CURRENT_SHIFT_READ_EVIDENCE_FORBIDDEN_REQUEST_KEYS, } from './jsaCurrentShiftReadEvidence.js';
export const JSA_JOB_ACK_PROTOCOL_VERSION = 1;
export const SUPPORTED_JSA_JOB_ACK_PROTOCOL_VERSIONS = Object.freeze([JSA_JOB_ACK_PROTOCOL_VERSION]);
export function isJsaJobAckProtocolVersion(v) {
    return v === JSA_JOB_ACK_PROTOCOL_VERSION;
}
export const JSA_JOB_ACK_CALLABLE = 'jsaAcknowledgeJob';
export const JSA_JOB_ACK_AUDIENCE = 'wbt';
export const JSA_JOB_ACK_METHOD = 'acknowledged';
export const JSA_JOB_ACK_COLLECTION = 'jsa_job_acknowledgments';
export const JSA_JOB_ACK_ID_DOMAIN = 'jsa-ack-v1';
export const JSA_JOB_ACK_SCHEMA_VERSION = 1;
/** Same bound as launch/receipt job refs. */
export const JSA_JOB_ACK_REF_MAX = 128;
export const JSA_JOB_ACK_CEREMONY_ID_MAX = 64;
export const JSA_JOB_ACK_REF_PATTERN = '^[A-Za-z0-9._-]{1,128}$';
export const JSA_JOB_ACK_CEREMONY_ID_PATTERN = '^[A-Za-z0-9._-]{1,64}$';
export function isJsaJobAckJobRef(v) {
    return typeof v === 'string' && new RegExp(`^${JSA_JOB_ACK_REF_PATTERN}$`).test(v);
}
export function isJsaJobAckCeremonyId(v) {
    return typeof v === 'string' && new RegExp(`^${JSA_JOB_ACK_CEREMONY_ID_PATTERN}$`).test(v);
}
/** Shape/audit metadata only. Never authority. */
export function isJsaJobAckObservedMs(v) {
    return typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v);
}
export const JSA_JOB_ACK_STATES = Object.freeze([
    'recorded',
    'already_recorded',
]);
export function isJsaJobAckState(v) {
    return v === 'recorded' || v === 'already_recorded';
}
export const JSA_JOB_ACK_REQUEST_KEYS = Object.freeze([
    'protocolVersion',
    'jobRef',
    'acknowledgedAtMs',
    'ceremonyId',
]);
export const JSA_JOB_ACK_REQUEST_REQUIRED_KEYS = Object.freeze([
    'protocolVersion',
    'jobRef',
]);
/**
 * Identity/authority keys. Presence is a hard refuse — they are not
 * ignored after parse. Includes the current-shift resolver forbidden
 * set so the two surfaces cannot drift.
 */
export const JSA_JOB_ACK_FORBIDDEN_REQUEST_KEYS = Object.freeze(Array.from(new Set([
    ...JSA_CURRENT_SHIFT_READ_EVIDENCE_FORBIDDEN_REQUEST_KEYS,
    'companyId',
    'driverId',
    'driverHash',
    'uid',
    'periodId',
    'openPeriodId',
    'shiftId',
    'originLocalDate',
    'requestId',
    'action',
    'intent',
    'legalName',
    'name',
    'displayName',
    'ticket',
    'ticketNumber',
    'groupRef',
    'hash',
    'passcode',
    // jobRef is required on THIS surface; the current-shift resolver
    // forbids it because that callable has no job. Strip it here.
])).filter((k) => k !== 'jobRef'));
export const JSA_JOB_ACK_RESPONSE_KEYS = Object.freeze([
    'protocolVersion',
    'state',
]);
export const JSA_JOB_ACK_RESPONSE_FORBIDDEN_KEYS = Object.freeze([
    'jobRef',
    'periodId',
    'originLocalDate',
    'requestId',
    'action',
    'intent',
    'name',
    'displayName',
    'legalName',
    'signature',
    'dataBase64',
    'storagePath',
    'companyId',
    'driverId',
    'driverHash',
    'uid',
    'ceremonyId',
    'acknowledgedAtMs',
]);
export const JSA_JOB_ACK_REFUSALS = Object.freeze([
    'unauthenticated',
    'wrong_audience',
    'malformed',
    'client_identity',
    'not_found',
    'not_owner',
    'no_qualifying_read',
    'period_unverifiable',
    'authority_unverifiable',
]);
export function isJsaJobAckRefusal(v) {
    return JSA_JOB_ACK_REFUSALS.includes(v);
}
function rec(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
        ? v
        : null;
}
export function validateJsaJobAckRequest(input) {
    const o = rec(input);
    if (!o)
        return { ok: false, errorCode: 'malformed_request', field: 'root' };
    const keys = Object.keys(o);
    for (const k of keys) {
        if (JSA_JOB_ACK_FORBIDDEN_REQUEST_KEYS.includes(k)) {
            return { ok: false, errorCode: 'client_identity', field: k };
        }
    }
    if (!keys.every((k) => JSA_JOB_ACK_REQUEST_KEYS.includes(k))) {
        return { ok: false, errorCode: 'malformed_request', field: 'unknown_key' };
    }
    if (!Object.prototype.hasOwnProperty.call(o, 'protocolVersion')) {
        return { ok: false, errorCode: 'malformed_request', field: 'protocolVersion' };
    }
    if (typeof o.protocolVersion !== 'number') {
        return { ok: false, errorCode: 'malformed_request', field: 'protocolVersion' };
    }
    if (o.protocolVersion !== JSA_JOB_ACK_PROTOCOL_VERSION) {
        return { ok: false, errorCode: 'unsupported_protocol', field: 'protocolVersion' };
    }
    if (!isJsaJobAckJobRef(o.jobRef)) {
        return { ok: false, errorCode: 'malformed_request', field: 'jobRef' };
    }
    if (Object.prototype.hasOwnProperty.call(o, 'acknowledgedAtMs')
        && !isJsaJobAckObservedMs(o.acknowledgedAtMs)) {
        return { ok: false, errorCode: 'malformed_request', field: 'acknowledgedAtMs' };
    }
    if (Object.prototype.hasOwnProperty.call(o, 'ceremonyId')
        && !isJsaJobAckCeremonyId(o.ceremonyId)) {
        return { ok: false, errorCode: 'malformed_request', field: 'ceremonyId' };
    }
    const value = {
        protocolVersion: JSA_JOB_ACK_PROTOCOL_VERSION,
        jobRef: o.jobRef,
    };
    if (Object.prototype.hasOwnProperty.call(o, 'acknowledgedAtMs')) {
        value.acknowledgedAtMs = o.acknowledgedAtMs;
    }
    if (Object.prototype.hasOwnProperty.call(o, 'ceremonyId')) {
        value.ceremonyId = o.ceremonyId;
    }
    return { ok: true, value };
}
export function validateJsaJobAckResponse(input) {
    const o = rec(input);
    if (!o)
        return { ok: false, errorCode: 'malformed_request', field: 'root' };
    for (const k of Object.keys(o)) {
        if (JSA_JOB_ACK_RESPONSE_FORBIDDEN_KEYS.includes(k)) {
            return { ok: false, errorCode: 'malformed_request', field: k };
        }
    }
    if (o.protocolVersion !== JSA_JOB_ACK_PROTOCOL_VERSION) {
        return { ok: false, errorCode: 'unsupported_protocol', field: 'protocolVersion' };
    }
    if (!isJsaJobAckState(o.state)) {
        return { ok: false, errorCode: 'malformed_request', field: 'state' };
    }
    if (!hasOnlyKeys(o, JSA_JOB_ACK_RESPONSE_KEYS)) {
        return { ok: false, errorCode: 'malformed_request', field: 'unknown_key' };
    }
    return {
        ok: true,
        value: {
            protocolVersion: JSA_JOB_ACK_PROTOCOL_VERSION,
            state: o.state,
        },
    };
}
/**
 * Length-prefixed, domain-separated preimage for the acknowledgment
 * document id. SHA-256 of this string (hex) is the document id.
 * Concatenation cannot alias because each field is prefixed with its
 * decimal byte-length in UTF-8.
 */
export function jsaJobAckIdPreimage(companyId, driverId, jobRef) {
    const parts = [companyId, driverId, jobRef].map((p) => `${p.length}:${p}`);
    return `${JSA_JOB_ACK_ID_DOMAIN}|${parts.join('|')}`;
}
export const JSA_JOB_ACK_RECORD_FORBIDDEN_KEYS = Object.freeze([
    'requestId',
    'action',
    'intent',
    'legalName',
    'signature',
    'dataBase64',
    'ppeSelected',
    'notes',
    'wells',
    'locations',
    'template',
]);
//# sourceMappingURL=jsaJobAcknowledgment.js.map