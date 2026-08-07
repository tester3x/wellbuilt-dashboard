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
import { DVIR_BOUNDS, isBoundedId, isDvirPhase, isIsoTimestamp, isDvirRequestConsumable, phaseForRecordKind, } from './protocol.js';
import { validateDvirNormalizedEvidence, } from './evidence.js';
export const DVIR_REQUEST_KEYS = Object.freeze([
    'protocolVersion', 'requestId', 'status', 'phase', 'companyId', 'driverId',
    'binding', 'issuedAtServer', 'expiresAtServer', 'completionId', 'cancelledAtServer',
]);
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
export const DVIR_REQUEST_ID_PATTERN = '^[A-Za-z0-9_-]{32,120}$';
export function isDvirRequestId(v) {
    return typeof v === 'string' && /^[A-Za-z0-9_-]{32,120}$/.test(v);
}
export const DVIR_COMPLETION_ID_PATTERN = '^[A-Za-z0-9_-]{32,120}$';
export function isDvirCompletionId(v) {
    return typeof v === 'string' && /^[A-Za-z0-9_-]{32,120}$/.test(v);
}
export const DVIR_COMPLETION_SUBMISSION_KEYS = Object.freeze([
    'protocolVersion', 'requestId', 'phase', 'inspectionRecordId', 'evidence',
    'claimedBinding', 'observedCompletedAtClient', 'artifactRefs',
]);
export const DVIR_COMPLETION_RECORD_KEYS = Object.freeze([
    'protocolVersion', 'completionId', 'requestId', 'phase', 'companyId', 'driverId',
    'binding', 'inspectionRecordId', 'evidence', 'evidenceDigest',
    'observedCompletedAtClient', 'acceptedAtServer', 'outcome',
]);
export const DVIR_COMPLETION_VIEW_KEYS = Object.freeze([
    'protocolVersion', 'completionId', 'requestId', 'phase', 'companyId', 'driverId',
    'binding', 'inspectionRecordId', 'outcome', 'evidenceDigest', 'acceptedAtServer',
]);
/** Fields that must NEVER appear in the lightweight view or a deep link. */
export const DVIR_VIEW_FORBIDDEN_KEYS = Object.freeze([
    'evidence', 'attestation', 'signerDisplayName', 'claimedSignerId',
    'issues', 'areas', 'explanation', 'artifactRefs',
]);
/** Derive the view from the record — the ONE place the mapping exists. */
export function toDvirCompletionView(record) {
    return {
        protocolVersion: record.protocolVersion,
        completionId: record.completionId,
        requestId: record.requestId,
        phase: record.phase,
        companyId: record.companyId,
        driverId: record.driverId,
        binding: record.binding,
        inspectionRecordId: record.inspectionRecordId,
        outcome: record.outcome,
        evidenceDigest: record.evidenceDigest,
        acceptedAtServer: record.acceptedAtServer,
    };
}
/** One-to-one: a view belongs to exactly one record. */
export function viewMatchesRecord(view, record) {
    return view.completionId === record.completionId
        && view.requestId === record.requestId
        && view.phase === record.phase
        && view.companyId === record.companyId
        && view.driverId === record.driverId
        && view.inspectionRecordId === record.inspectionRecordId
        && view.evidenceDigest === record.evidenceDigest
        && view.acceptedAtServer === record.acceptedAtServer
        && view.binding.periodId === record.binding.periodId
        && view.binding.kind === record.binding.kind;
}
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Validate an authenticated submission against the SERVER's request and
 * its INDEPENDENTLY re-resolved period binding.
 *
 * `serverFacts` must come from verified claims + the server's own period
 * resolution — never from the submission.
 */
export function validateDvirCompletionSubmission(raw, request, serverFacts) {
    if (!isObj(raw))
        return { ok: false, reason: 'not_object' };
    // Checked BEFORE the generic unknown-key sweep: a client attempting to
    // supply a server-authoritative timestamp is a distinct and more
    // meaningful rejection than "unknown field".
    if ('acceptedAtServer' in raw || 'issuedAtServer' in raw || 'recordedAtServer' in raw) {
        return { ok: false, reason: 'server_timestamp_supplied' };
    }
    const unknown = Object.keys(raw).filter((k) => !DVIR_COMPLETION_SUBMISSION_KEYS.includes(k));
    if (unknown.length)
        return { ok: false, reason: 'unknown_fields', detail: unknown.join(',') };
    for (const k of ['protocolVersion', 'requestId', 'phase', 'inspectionRecordId',
        'evidence', 'observedCompletedAtClient']) {
        if (raw[k] === undefined)
            return { ok: false, reason: 'missing_fields', detail: k };
    }
    if (typeof raw.protocolVersion !== 'number') {
        return { ok: false, reason: 'unsupported_protocol_version' };
    }
    if (raw.protocolVersion < request.protocolVersion) {
        return { ok: false, reason: 'protocol_downgrade' };
    }
    if (raw.protocolVersion !== request.protocolVersion) {
        return { ok: false, reason: 'unsupported_protocol_version' };
    }
    if (!isDvirRequestId(raw.requestId))
        return { ok: false, reason: 'invalid_request_id' };
    if (raw.requestId !== request.requestId)
        return { ok: false, reason: 'invalid_request_id' };
    if (request.status === 'completed')
        return { ok: false, reason: 'request_already_completed' };
    if (request.status === 'cancelled')
        return { ok: false, reason: 'request_cancelled' };
    if (request.status === 'expired')
        return { ok: false, reason: 'request_expired' };
    if (!isDvirRequestConsumable(request.status, request.expiresAtServer, serverFacts.nowMs)) {
        return { ok: false, reason: request.status === 'open' ? 'request_expired' : 'request_not_open' };
    }
    if (!isDvirPhase(raw.phase) || raw.phase !== request.phase) {
        return { ok: false, reason: 'phase_mismatch' };
    }
    if (serverFacts.companyId !== request.companyId)
        return { ok: false, reason: 'company_mismatch' };
    if (serverFacts.driverId !== request.driverId)
        return { ok: false, reason: 'driver_mismatch' };
    // Independently re-resolved binding must still match the request's.
    if (phaseForRecordKind(serverFacts.binding.kind) !== request.phase) {
        return { ok: false, reason: 'binding_kind_mismatch' };
    }
    if (serverFacts.binding.periodId !== request.binding.periodId) {
        return { ok: false, reason: 'period_mismatch' };
    }
    if (!serverFacts.periodOperationallyOpen)
        return { ok: false, reason: 'period_not_open' };
    // A claimed binding is compared, never adopted.
    if (raw.claimedBinding !== undefined) {
        const cb = raw.claimedBinding;
        if (!isObj(cb))
            return { ok: false, reason: 'period_mismatch', detail: 'claimedBinding' };
        if (cb.periodId !== undefined && cb.periodId !== serverFacts.binding.periodId) {
            return { ok: false, reason: 'period_mismatch', detail: 'claimed' };
        }
        if (cb.kind !== undefined && cb.kind !== serverFacts.binding.kind) {
            return { ok: false, reason: 'binding_kind_mismatch', detail: 'claimed' };
        }
        if (cb.mode !== undefined && cb.mode !== serverFacts.binding.mode) {
            return { ok: false, reason: 'period_mismatch', detail: 'claimed mode' };
        }
    }
    if (!isBoundedId(raw.inspectionRecordId)) {
        return { ok: false, reason: 'inspection_record_mismatch' };
    }
    if (!isIsoTimestamp(raw.observedCompletedAtClient)) {
        return { ok: false, reason: 'invalid_timestamps' };
    }
    const ev = validateDvirNormalizedEvidence(raw.evidence);
    if (!ev.ok || !ev.evidence) {
        return { ok: false, reason: 'invalid_evidence', detail: `${ev.reason}${ev.detail ? ':' + ev.detail : ''}` };
    }
    if (ev.evidence.phase !== raw.phase)
        return { ok: false, reason: 'evidence_phase_mismatch' };
    if (ev.evidence.inspectionRecordId !== raw.inspectionRecordId) {
        return { ok: false, reason: 'inspection_record_mismatch' };
    }
    if (raw.artifactRefs !== undefined) {
        if (!Array.isArray(raw.artifactRefs))
            return { ok: false, reason: 'unknown_fields', detail: 'artifactRefs' };
        for (const a of raw.artifactRefs) {
            if (!isObj(a) || (a.kind !== 'pdf' && a.kind !== 'evidence') || !isBoundedId(a.ref)) {
                return { ok: false, reason: 'unknown_fields', detail: 'artifactRef' };
            }
            if (/^\s*data:/i.test(String(a.ref)))
                return { ok: false, reason: 'artifact_binary_forbidden' };
            if (a.digest !== undefined && !isBoundedId(a.digest)) {
                return { ok: false, reason: 'unknown_fields', detail: 'artifact digest' };
            }
        }
    }
    return {
        ok: true,
        submission: {
            protocolVersion: raw.protocolVersion,
            requestId: raw.requestId,
            phase: raw.phase,
            inspectionRecordId: raw.inspectionRecordId,
            evidence: ev.evidence,
            ...(raw.claimedBinding !== undefined
                ? { claimedBinding: raw.claimedBinding } : {}),
            observedCompletedAtClient: raw.observedCompletedAtClient,
            ...(raw.artifactRefs !== undefined
                ? { artifactRefs: raw.artifactRefs } : {}),
        },
    };
}
/**
 * Idempotency: an equivalent re-submission for an already-completed
 * request is the SAME completion, not a second one. Conflicting content
 * for the same request is a genuine conflict.
 */
export function isEquivalentDvirCompletion(existing, candidate) {
    return existing.requestId === candidate.requestId
        && existing.phase === candidate.phase
        && existing.inspectionRecordId === candidate.inspectionRecordId
        && existing.evidenceDigest === candidate.evidenceDigest;
}
/** Does this completion satisfy an ENFORCED phase requirement? */
export function satisfiesEnforcedDvirPhase(record, expected) {
    return record.outcome === 'accepted'
        && record.phase === expected.phase
        && record.binding.periodId === expected.periodId
        && phaseForRecordKind(record.binding.kind) === expected.phase;
}
export { DVIR_BOUNDS };
//# sourceMappingURL=records.js.map