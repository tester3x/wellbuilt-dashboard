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
export declare const JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION: 1;
export type JsaCurrentShiftReadEvidenceProtocolVersion = typeof JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION;
export declare const SUPPORTED_JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSIONS: readonly number[];
export declare function isJsaCurrentShiftReadEvidenceProtocolVersion(v: unknown): v is JsaCurrentShiftReadEvidenceProtocolVersion;
/**
 * Terminal actions that attest a completed FULL READ.
 *
 * Canonical, single list. Acknowledge-only never qualifies. Shared so the
 * server lookup and WB-T's consume adapter cannot drift.
 */
export declare const JSA_READ_EVIDENCE_ACTIONS: readonly ["read_completed", "read_and_acknowledged"];
export type JsaReadEvidenceAction = (typeof JSA_READ_EVIDENCE_ACTIONS)[number];
export declare function isJsaReadEvidenceAction(v: unknown): v is JsaReadEvidenceAction;
/** True when the terminal action attests a completed full read. */
export declare function terminalActionIncludesRead(action: unknown): boolean;
export declare const JSA_CURRENT_SHIFT_READ_EVIDENCE_STATES: readonly ["read_bootstrapped", "none", "no_active_shift"];
export type JsaCurrentShiftReadEvidenceState = (typeof JSA_CURRENT_SHIFT_READ_EVIDENCE_STATES)[number];
export declare function isJsaCurrentShiftReadEvidenceState(v: unknown): v is JsaCurrentShiftReadEvidenceState;
/** The request may carry ONLY protocolVersion. */
export declare const JSA_CURRENT_SHIFT_READ_EVIDENCE_REQUEST_KEYS: readonly ["protocolVersion"];
/**
 * Fields that MUST NEVER be accepted as request authority. Presence is
 * a hard refuse — they are not ignored after parse, so a hostile client
 * cannot probe whether the server would have used them.
 */
export declare const JSA_CURRENT_SHIFT_READ_EVIDENCE_FORBIDDEN_REQUEST_KEYS: readonly ["companyId", "driverId", "driverHash", "uid", "shiftId", "periodId", "openPeriodId", "originLocalDate", "requestId", "jobRef", "groupRef", "ticket", "ticketNumber", "name", "displayName", "legalName", "hash", "passcode"];
export declare const JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_BOOTSTRAPPED_KEYS: readonly ["protocolVersion", "state", "periodId"];
export declare const JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_NONE_KEYS: readonly ["protocolVersion", "state", "periodId"];
export declare const JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_NO_SHIFT_KEYS: readonly ["protocolVersion", "state"];
export declare const JSA_CURRENT_SHIFT_READ_EVIDENCE_RESPONSE_FORBIDDEN_KEYS: readonly ["requestId", "jobRef", "groupRef", "action", "intent", "name", "displayName", "legalName", "signature", "dataBase64", "storagePath"];
export interface JsaCurrentShiftReadEvidenceRequest {
    protocolVersion: JsaCurrentShiftReadEvidenceProtocolVersion;
}
export type JsaCurrentShiftReadEvidenceResponse = {
    protocolVersion: JsaCurrentShiftReadEvidenceProtocolVersion;
    state: 'read_bootstrapped';
    periodId: string;
} | {
    protocolVersion: JsaCurrentShiftReadEvidenceProtocolVersion;
    state: 'none';
    periodId: string;
} | {
    protocolVersion: JsaCurrentShiftReadEvidenceProtocolVersion;
    state: 'no_active_shift';
};
export type JsaCurrentShiftReadEvidenceErrorCode = 'unsupported_protocol' | 'malformed_request' | 'client_identity';
export type JsaCurrentShiftReadEvidenceValidation<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    errorCode: JsaCurrentShiftReadEvidenceErrorCode;
    field: string;
};
export declare function validateJsaCurrentShiftReadEvidenceRequest(input: unknown): JsaCurrentShiftReadEvidenceValidation<JsaCurrentShiftReadEvidenceRequest>;
export declare function validateJsaCurrentShiftReadEvidenceResponse(input: unknown): JsaCurrentShiftReadEvidenceValidation<JsaCurrentShiftReadEvidenceResponse>;
/**
 * A stored governed-request projection the server may consider. The
 * lookup applies these filters AFTER a company+driver+period query so a
 * hostile extra field on a stored doc cannot widen the result.
 */
export type JsaCurrentShiftReadEvidenceRecord = {
    companyId: string;
    driverId: string;
    state: string;
    action: unknown;
    bindingPeriodId: string | null;
};
/**
 * Pure decision over already-fetched records. Does not talk to storage.
 * A matching completed read-bearing action → read_bootstrapped.
 * Otherwise none. Callers map "no open period" to no_active_shift
 * BEFORE invoking this — an unverifiable authority must never reach
 * here as an empty list (that would degrade to none).
 */
export declare function decideCurrentShiftReadEvidence(periodId: string, records: readonly JsaCurrentShiftReadEvidenceRecord[], expect: {
    companyId: string;
    driverId: string;
}): 'read_bootstrapped' | 'none';
//# sourceMappingURL=jsaCurrentShiftReadEvidence.d.ts.map