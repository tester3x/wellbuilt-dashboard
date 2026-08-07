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
import { DVIR_BOUNDS, isBoundedId, isDvirPhase, isIsoTimestamp, } from './protocol.js';
/** The one recognized missing-evidence kind, mirroring the domain constant. */
export const DVIR_MISSING_EVIDENCE_KINDS = Object.freeze(['pre_trip_not_captured']);
export const DVIR_MISSING_EVIDENCE_OUTCOME = 'recorded_missing_evidence';
export const DVIR_MISSING_EVIDENCE_KEYS = Object.freeze([
    'protocolVersion', 'kind', 'claimedPhase', 'claimedPeriodId', 'reason',
    'observedAtClient', 'inspectionRecordId',
]);
export const DVIR_MISSING_EVIDENCE_RECORD_KEYS = Object.freeze([
    'protocolVersion', 'exceptionId', 'kind', 'companyId', 'driverId', 'phase',
    'periodId', 'reason', 'observedAtClient', 'recordedAtServer', 'outcome',
    'inspectionRecordId',
]);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Parse a missing-evidence submission. Anything carrying completion
 * material (evidence, attestation, digests) is rejected outright — the
 * two shapes must never blur.
 */
export function validateDvirMissingEvidenceSubmission(raw, expectedProtocolVersion) {
    if (!isObj(raw))
        return { ok: false, reason: 'not_object' };
    const unknown = Object.keys(raw).filter((k) => !DVIR_MISSING_EVIDENCE_KEYS.includes(k));
    if (unknown.length) {
        const completionish = unknown.filter((k) => ['evidence', 'attestation', 'evidenceDigest', 'completionId', 'outcome'].includes(k));
        return {
            ok: false,
            reason: completionish.length ? 'completion_fields_present' : 'unknown_fields',
            detail: unknown.join(','),
        };
    }
    for (const k of ['protocolVersion', 'kind', 'claimedPhase', 'claimedPeriodId', 'reason', 'observedAtClient']) {
        if (raw[k] === undefined)
            return { ok: false, reason: 'missing_fields', detail: k };
    }
    if (raw.protocolVersion !== expectedProtocolVersion) {
        return { ok: false, reason: 'unsupported_protocol_version' };
    }
    if (raw.kind !== 'pre_trip_not_captured')
        return { ok: false, reason: 'invalid_kind' };
    if (!isDvirPhase(raw.claimedPhase))
        return { ok: false, reason: 'invalid_phase' };
    if (!isBoundedId(raw.claimedPeriodId))
        return { ok: false, reason: 'invalid_period' };
    if (typeof raw.reason !== 'string' || raw.reason.trim().length === 0
        || raw.reason.length > DVIR_BOUNDS.reasonMax) {
        return { ok: false, reason: 'invalid_reason' };
    }
    if (!isIsoTimestamp(raw.observedAtClient))
        return { ok: false, reason: 'invalid_timestamps' };
    if (raw.inspectionRecordId !== undefined && !isBoundedId(raw.inspectionRecordId)) {
        return { ok: false, reason: 'missing_fields', detail: 'inspectionRecordId' };
    }
    return {
        ok: true,
        submission: {
            protocolVersion: raw.protocolVersion,
            kind: 'pre_trip_not_captured',
            claimedPhase: raw.claimedPhase,
            claimedPeriodId: raw.claimedPeriodId,
            reason: raw.reason.trim(),
            observedAtClient: raw.observedAtClient,
            ...(raw.inspectionRecordId !== undefined
                ? { inspectionRecordId: raw.inspectionRecordId } : {}),
        },
    };
}
/**
 * THE guard: a missing-evidence record can never satisfy an enforced
 * phase, transition a request to `completed`, or yield a completion view.
 * Always false, by construction — there is no branch that returns true.
 */
export function missingEvidenceSatisfiesEnforcedPhase(_record) {
    return false;
}
/** Runtime discriminator usable on an unknown submission. */
export function isDvirMissingEvidenceSubmission(v) {
    return isObj(v) && v.kind === 'pre_trip_not_captured' && v.evidence === undefined;
}
/** Honest UI/report status label — never "completed". */
export const DVIR_MISSING_EVIDENCE_LABEL = 'Pre-Trip not captured — evidence missing (not a completed inspection)';
//# sourceMappingURL=missingEvidence.js.map