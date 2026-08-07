/**
 * Canonical DVIR request / submission / completion / view records (vc51.9E).
 *
 * CLIENT CLAIMS vs SERVER FACTS — the central rule of this protocol:
 *   * every client-supplied field is named `claimed*` or `*Client`;
 *   * every server-derived field is plain-named and may ONLY be produced
 *     by the server (`companyId`, `driverId`, `binding`, `acceptedAtServer`);
 *   * validators compare claims against server facts and reject
 *     disagreement — they never adopt a claim as authority.
 *
 * The server record honestly proves: an authenticated driver submission
 * carrying the preserved normalized evidence passed canonical validation
 * and was accepted by the server for the verified company, driver, phase,
 * and work period. It does NOT independently prove the physical
 * inspection beyond the submitted evidence.
 */
import type { ShiftScopedBinding } from '../types.js';
import { DVIR_BOUNDS, type DvirCompletionOutcome, type DvirPhase, type DvirRequestStatus } from './protocol.js';
import { type DvirNormalizedEvidence } from './evidence.js';
export interface DvirRequest {
    protocolVersion: number;
    /** Opaque, high-entropy, server-minted. Never client-chosen. */
    requestId: string;
    status: DvirRequestStatus;
    phase: DvirPhase;
    /** Server-derived from verified claims + active profile. */
    companyId: string;
    driverId: string;
    /** Server-verified canonical period binding (0.1.0 type, not a copy). */
    binding: ShiftScopedBinding;
    issuedAtServer: string;
    expiresAtServer?: string | null;
    /** Set when status transitions to `completed`. */
    completionId?: string | null;
    cancelledAtServer?: string | null;
}
export declare const DVIR_REQUEST_KEYS: readonly string[];
/**
 * Opaque request/completion ids: URL-safe, high-entropy, unenumerable.
 *
 * Exported as pattern STRINGS, never as RegExp objects. A shared RegExp
 * is mutable cross-call state (`lastIndex`) that a consumer could
 * corrupt, and freezing one is worse: a frozen `g`/`y` regex throws
 * `TypeError` on its second `.test()` because `.test` writes
 * `lastIndex`. A string cannot carry flags or state, and it is the form
 * Firestore rules need for `.matches(...)`.
 */
export declare const DVIR_REQUEST_ID_PATTERN = "^[A-Za-z0-9_-]{32,120}$";
export declare function isDvirRequestId(v: unknown): v is string;
export declare const DVIR_COMPLETION_ID_PATTERN = "^[A-Za-z0-9_-]{32,120}$";
export declare function isDvirCompletionId(v: unknown): v is string;
export interface DvirCompletionSubmission {
    protocolVersion: number;
    requestId: string;
    phase: DvirPhase;
    inspectionRecordId: string;
    evidence: DvirNormalizedEvidence;
    /** Client's view of the binding — compared, never trusted. */
    claimedBinding?: Pick<ShiftScopedBinding, 'periodId' | 'mode' | 'kind'>;
    observedCompletedAtClient: string;
    /** Optional immutable artifact references (never binary). */
    artifactRefs?: Array<{
        kind: 'pdf' | 'evidence';
        ref: string;
        digest?: string;
    }>;
}
export declare const DVIR_COMPLETION_SUBMISSION_KEYS: readonly string[];
export interface DvirCompletionRecord {
    protocolVersion: number;
    completionId: string;
    requestId: string;
    phase: DvirPhase;
    /** Server-derived — never echoed from the submission. */
    companyId: string;
    driverId: string;
    binding: ShiftScopedBinding;
    inspectionRecordId: string;
    evidence: DvirNormalizedEvidence;
    evidenceDigest: string;
    /** Client observation, honestly labeled. */
    observedCompletedAtClient: string;
    /** THE server-authoritative acceptance time. Server-only. */
    acceptedAtServer: string;
    outcome: DvirCompletionOutcome;
}
export declare const DVIR_COMPLETION_RECORD_KEYS: readonly string[];
/**
 * Lightweight verification view — what WB-S exact-gets.
 * Deliberately EXCLUDES signerDisplayName, items, issues, explanations,
 * and every artifact ref (vc51.9E decision 3).
 */
export interface DvirCompletionView {
    protocolVersion: number;
    completionId: string;
    requestId: string;
    phase: DvirPhase;
    companyId: string;
    driverId: string;
    binding: ShiftScopedBinding;
    inspectionRecordId: string;
    outcome: DvirCompletionOutcome;
    evidenceDigest: string;
    acceptedAtServer: string;
}
export declare const DVIR_COMPLETION_VIEW_KEYS: readonly string[];
/** Fields that must NEVER appear in the lightweight view or a deep link. */
export declare const DVIR_VIEW_FORBIDDEN_KEYS: readonly string[];
/** Derive the view from the record — the ONE place the mapping exists. */
export declare function toDvirCompletionView(record: DvirCompletionRecord): DvirCompletionView;
/** One-to-one: a view belongs to exactly one record. */
export declare function viewMatchesRecord(view: DvirCompletionView, record: DvirCompletionRecord): boolean;
export type DvirSubmissionRejection = 'not_object' | 'unknown_fields' | 'missing_fields' | 'unsupported_protocol_version' | 'protocol_downgrade' | 'invalid_request_id' | 'request_not_open' | 'request_expired' | 'request_cancelled' | 'request_already_completed' | 'phase_mismatch' | 'company_mismatch' | 'driver_mismatch' | 'binding_kind_mismatch' | 'period_mismatch' | 'period_not_open' | 'inspection_record_mismatch' | 'invalid_evidence' | 'evidence_phase_mismatch' | 'invalid_timestamps' | 'artifact_binary_forbidden' | 'server_timestamp_supplied';
export interface DvirSubmissionResult {
    ok: boolean;
    reason?: DvirSubmissionRejection;
    detail?: string;
    submission?: DvirCompletionSubmission;
}
/**
 * Validate an authenticated submission against the SERVER's request and
 * its INDEPENDENTLY re-resolved period binding.
 *
 * `serverFacts` must come from verified claims + the server's own period
 * resolution — never from the submission.
 */
export declare function validateDvirCompletionSubmission(raw: unknown, request: DvirRequest, serverFacts: {
    companyId: string;
    driverId: string;
    /** Freshly re-resolved binding at submission time. */
    binding: ShiftScopedBinding;
    periodOperationallyOpen: boolean;
    nowMs: number;
}): DvirSubmissionResult;
/**
 * Idempotency: an equivalent re-submission for an already-completed
 * request is the SAME completion, not a second one. Conflicting content
 * for the same request is a genuine conflict.
 */
export declare function isEquivalentDvirCompletion(existing: DvirCompletionRecord, candidate: {
    requestId: string;
    phase: DvirPhase;
    inspectionRecordId: string;
    evidenceDigest: string;
}): boolean;
/** Does this completion satisfy an ENFORCED phase requirement? */
export declare function satisfiesEnforcedDvirPhase(record: Pick<DvirCompletionRecord, 'outcome' | 'phase' | 'binding' | 'protocolVersion'>, expected: {
    phase: DvirPhase;
    periodId: string;
}): boolean;
export { DVIR_BOUNDS };
//# sourceMappingURL=records.d.ts.map