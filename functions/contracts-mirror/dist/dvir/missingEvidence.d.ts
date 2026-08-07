/**
 * Missing-evidence exception (vc51.9E Part 4) — NOT a completion.
 *
 * The eQuipment domain can legitimately reach a state where a Post-Trip
 * exists for a shift whose Pre-Trip was never captured
 * (`preTripNotCaptured: true`, reason `legacy_shift_pre_trip_unavailable`
 * — shiftDvir.ts:54-56, set only by createLegacyPostTripOnlyDraft:169).
 * That is TRUTHFUL HISTORY, not compliance.
 *
 * This module keeps it permanently separable:
 *   * a distinct type that is NOT DvirCompletionSubmission;
 *   * an outcome (`recorded_missing_evidence`) outside
 *     DvirCompletionOutcome, so no union widening can smuggle it in;
 *   * `satisfiesEnforcedDvirPhase` is not implemented for it at all;
 *   * no completionId, no evidenceDigest, no accepted outcome — so no
 *     completion receipt or view can be derived from it.
 *
 * It may be RECORDED where server policy explicitly permits legacy/history
 * capture. It must never unlock an enforced phase.
 */
import { type DvirPhase } from './protocol.js';
/** The one recognized missing-evidence kind, mirroring the domain constant. */
export declare const DVIR_MISSING_EVIDENCE_KINDS: readonly ["pre_trip_not_captured"];
export type DvirMissingEvidenceKind = (typeof DVIR_MISSING_EVIDENCE_KINDS)[number];
/** Deliberately OUTSIDE DvirCompletionOutcome — never assignable to it. */
export type DvirMissingEvidenceOutcome = 'recorded_missing_evidence';
export declare const DVIR_MISSING_EVIDENCE_OUTCOME: DvirMissingEvidenceOutcome;
export interface DvirMissingEvidenceSubmission {
    protocolVersion: number;
    kind: DvirMissingEvidenceKind;
    /** Claimed until the server resolves it — never authority. */
    claimedPhase: DvirPhase;
    claimedPeriodId: string;
    /** The domain's own reason string, preserved honestly. */
    reason: string;
    observedAtClient: string;
    /** The record this exception describes, when one exists. */
    inspectionRecordId?: string;
}
export declare const DVIR_MISSING_EVIDENCE_KEYS: readonly string[];
export interface DvirMissingEvidenceRecord {
    protocolVersion: number;
    exceptionId: string;
    kind: DvirMissingEvidenceKind;
    companyId: string;
    driverId: string;
    /** Server-resolved phase/period this exception is filed against. */
    phase: DvirPhase;
    periodId: string;
    reason: string;
    observedAtClient: string;
    recordedAtServer: string;
    /** ALWAYS the non-completing outcome. */
    outcome: DvirMissingEvidenceOutcome;
    inspectionRecordId?: string;
}
export declare const DVIR_MISSING_EVIDENCE_RECORD_KEYS: readonly string[];
export type DvirMissingEvidenceRejection = 'not_object' | 'unknown_fields' | 'missing_fields' | 'invalid_kind' | 'invalid_phase' | 'invalid_period' | 'invalid_reason' | 'invalid_timestamps' | 'unsupported_protocol_version' | 'completion_fields_present';
export interface DvirMissingEvidenceResult {
    ok: boolean;
    reason?: DvirMissingEvidenceRejection;
    detail?: string;
    submission?: DvirMissingEvidenceSubmission;
}
/**
 * Parse a missing-evidence submission. Anything carrying completion
 * material (evidence, attestation, digests) is rejected outright — the
 * two shapes must never blur.
 */
export declare function validateDvirMissingEvidenceSubmission(raw: unknown, expectedProtocolVersion: number): DvirMissingEvidenceResult;
/**
 * THE guard: a missing-evidence record can never satisfy an enforced
 * phase, transition a request to `completed`, or yield a completion view.
 * Always false, by construction — there is no branch that returns true.
 */
export declare function missingEvidenceSatisfiesEnforcedPhase(_record: DvirMissingEvidenceRecord): false;
/** Runtime discriminator usable on an unknown submission. */
export declare function isDvirMissingEvidenceSubmission(v: unknown): v is DvirMissingEvidenceSubmission;
/** Honest UI/report status label — never "completed". */
export declare const DVIR_MISSING_EVIDENCE_LABEL = "Pre-Trip not captured \u2014 evidence missing (not a completed inspection)";
//# sourceMappingURL=missingEvidence.d.ts.map