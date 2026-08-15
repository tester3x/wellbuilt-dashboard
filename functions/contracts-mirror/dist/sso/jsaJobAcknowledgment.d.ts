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
export declare const JSA_JOB_ACK_PROTOCOL_VERSION: 1;
export type JsaJobAckProtocolVersion = typeof JSA_JOB_ACK_PROTOCOL_VERSION;
export declare const SUPPORTED_JSA_JOB_ACK_PROTOCOL_VERSIONS: readonly number[];
export declare function isJsaJobAckProtocolVersion(v: unknown): v is JsaJobAckProtocolVersion;
export declare const JSA_JOB_ACK_CALLABLE: "jsaAcknowledgeJob";
export declare const JSA_JOB_ACK_AUDIENCE: "wbt";
export declare const JSA_JOB_ACK_METHOD: "acknowledged";
export declare const JSA_JOB_ACK_COLLECTION: "jsa_job_acknowledgments";
export declare const JSA_JOB_ACK_ID_DOMAIN: "jsa-ack-v1";
export declare const JSA_JOB_ACK_SCHEMA_VERSION: 1;
/** Same bound as launch/receipt job refs. */
export declare const JSA_JOB_ACK_REF_MAX = 128;
export declare const JSA_JOB_ACK_CEREMONY_ID_MAX = 64;
export declare const JSA_JOB_ACK_REF_PATTERN = "^[A-Za-z0-9._-]{1,128}$";
export declare const JSA_JOB_ACK_CEREMONY_ID_PATTERN = "^[A-Za-z0-9._-]{1,64}$";
export declare function isJsaJobAckJobRef(v: unknown): v is string;
export declare function isJsaJobAckCeremonyId(v: unknown): v is string;
/** Shape/audit metadata only. Never authority. */
export declare function isJsaJobAckObservedMs(v: unknown): v is number;
export declare const JSA_JOB_ACK_STATES: readonly ["recorded", "already_recorded"];
export type JsaJobAckState = (typeof JSA_JOB_ACK_STATES)[number];
export declare function isJsaJobAckState(v: unknown): v is JsaJobAckState;
export declare const JSA_JOB_ACK_REQUEST_KEYS: readonly ["protocolVersion", "jobRef", "acknowledgedAtMs", "ceremonyId"];
export declare const JSA_JOB_ACK_REQUEST_REQUIRED_KEYS: readonly ["protocolVersion", "jobRef"];
/**
 * Identity/authority keys. Presence is a hard refuse — they are not
 * ignored after parse. Includes the current-shift resolver forbidden
 * set so the two surfaces cannot drift.
 */
export declare const JSA_JOB_ACK_FORBIDDEN_REQUEST_KEYS: readonly string[];
export declare const JSA_JOB_ACK_RESPONSE_KEYS: readonly ["protocolVersion", "state"];
export declare const JSA_JOB_ACK_RESPONSE_FORBIDDEN_KEYS: readonly ["jobRef", "periodId", "originLocalDate", "requestId", "action", "intent", "name", "displayName", "legalName", "signature", "dataBase64", "storagePath", "companyId", "driverId", "driverHash", "uid", "ceremonyId", "acknowledgedAtMs"];
export declare const JSA_JOB_ACK_REFUSALS: readonly ["unauthenticated", "wrong_audience", "malformed", "client_identity", "not_found", "not_owner", "no_qualifying_read", "period_unverifiable", "authority_unverifiable"];
export type JsaJobAckRefusal = (typeof JSA_JOB_ACK_REFUSALS)[number];
export declare function isJsaJobAckRefusal(v: unknown): v is JsaJobAckRefusal;
export interface JsaJobAckRequest {
    protocolVersion: JsaJobAckProtocolVersion;
    jobRef: string;
    acknowledgedAtMs?: number;
    ceremonyId?: string;
}
export type JsaJobAckResponse = {
    protocolVersion: JsaJobAckProtocolVersion;
    state: JsaJobAckState;
};
export type JsaJobAckErrorCode = 'unsupported_protocol' | 'malformed_request' | 'client_identity';
export type JsaJobAckValidation<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    errorCode: JsaJobAckErrorCode;
    field: string;
};
export declare function validateJsaJobAckRequest(input: unknown): JsaJobAckValidation<JsaJobAckRequest>;
export declare function validateJsaJobAckResponse(input: unknown): JsaJobAckValidation<JsaJobAckResponse>;
/**
 * Length-prefixed, domain-separated preimage for the acknowledgment
 * document id. SHA-256 of this string (hex) is the document id.
 * Concatenation cannot alias because each field is prefixed with its
 * decimal byte-length in UTF-8.
 */
export declare function jsaJobAckIdPreimage(companyId: string, driverId: string, jobRef: string): string;
/**
 * Stored record shape. Identity of the document is the hash of
 * jsaJobAckIdPreimage — never a client ceremony id.
 */
export type JsaJobAckRecord = {
    schemaVersion: typeof JSA_JOB_ACK_SCHEMA_VERSION;
    companyId: string;
    driverId: string;
    jobRef: string;
    periodId: string;
    originLocalDate: string;
    recordedAtMs: number;
    method: typeof JSA_JOB_ACK_METHOD;
    clientObservedAtMs?: number;
    ceremonyId?: string;
};
export declare const JSA_JOB_ACK_RECORD_FORBIDDEN_KEYS: readonly ["requestId", "action", "intent", "legalName", "signature", "dataBase64", "ppeSelected", "notes", "wells", "locations", "template"];
//# sourceMappingURL=jsaJobAcknowledgment.d.ts.map