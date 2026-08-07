/**
 * Canonical DVIR request/completion protocol (vc51.9E) — primitives.
 *
 * ONE shared protocol for WB-S, eQuipment, Dashboard Functions, and
 * Firestore rule-source pins. Every literal, key set, bound, and state
 * transition lives here exactly once so the JSA receipt v1/v2 outcome —
 * the same key sets hand-copied into three repositories — cannot repeat.
 *
 * INDEPENDENT VERSION. `DVIR_PROTOCOL_VERSION` is deliberately separate
 * from `CONTRACT_VERSION` (which versions the company-contract schema and
 * stays 1): the wire protocol and the company contract must be able to
 * move apart. Unknown protocol versions fail closed.
 *
 * ADDITIVE ONLY. Nothing in this module changes any 0.1.0 export.
 *
 * Derived from the established eQuipment domain (packages/dvir-domain),
 * not from assumptions — see docs in DvirNormalizedEvidence for the
 * field-by-field provenance.
 */
export const DVIR_PROTOCOL_VERSION = 1;
export const SUPPORTED_DVIR_PROTOCOL_VERSIONS = Object.freeze([
    DVIR_PROTOCOL_VERSION,
]);
/** Fail closed on any unknown/future protocol version. */
export function assertDvirProtocolCompatible(version, consumerName) {
    if (!SUPPORTED_DVIR_PROTOCOL_VERSIONS.includes(version)) {
        throw new Error(`[@tester3x/wellbuilt-contracts] ${consumerName} cannot consume DVIR protocol version ` +
            `${version}; supported: ${SUPPORTED_DVIR_PROTOCOL_VERSIONS.join(', ')}`);
    }
}
/**
 * A v2-capable requester must never accept a v1 answer, and vice versa —
 * the answered version must EQUAL the requested one.
 */
export function isDvirProtocolDowngrade(requested, answered) {
    return answered < requested;
}
export const DVIR_PHASES = Object.freeze(['pre_trip', 'post_trip']);
export function isDvirPhase(v) {
    return v === 'pre_trip' || v === 'post_trip';
}
/** The 0.1.0 shift-scoped record kind a phase binds as — no new vocabulary. */
export function recordKindForPhase(phase) {
    return phase === 'pre_trip' ? 'dvir_pre_trip' : 'dvir_post_trip';
}
export function phaseForRecordKind(kind) {
    if (kind === 'dvir_pre_trip')
        return 'pre_trip';
    if (kind === 'dvir_post_trip')
        return 'post_trip';
    return null;
}
export const DVIR_REQUEST_STATUSES = Object.freeze(['open', 'completed', 'cancelled', 'expired']);
export function isDvirRequestStatus(v) {
    return typeof v === 'string' && DVIR_REQUEST_STATUSES.includes(v);
}
/**
 * Legal transitions. `open` is the only status a completion may consume,
 * and every terminal status is final — a completed request can never be
 * reopened, so a prior-period or duplicate submission cannot resurrect it.
 */
const LEGAL_TRANSITIONS = Object.freeze({
    open: Object.freeze(['completed', 'cancelled', 'expired']),
    completed: Object.freeze([]),
    cancelled: Object.freeze([]),
    expired: Object.freeze([]),
});
export function isLegalDvirRequestTransition(from, to) {
    return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}
/** Only an `open`, unexpired request may be completed. */
export function isDvirRequestConsumable(status, expiresAtIso, nowMs) {
    if (status !== 'open')
        return false;
    if (!expiresAtIso)
        return true;
    const exp = Date.parse(expiresAtIso);
    return !Number.isNaN(exp) && nowMs <= exp;
}
export const DVIR_ITEM_RESULTS = Object.freeze(['pass_by_area_completion', 'needs_attention']);
export function isDvirItemResult(v) {
    return v === 'pass_by_area_completion' || v === 'needs_attention';
}
/** Human-honest description — for UI/report copy, so no consumer invents its own. */
export const DVIR_ITEM_RESULT_MEANING = Object.freeze({
    pass_by_area_completion: 'No issue was reported before the driver completed this area (derived pass, not an individual per-item confirmation).',
    needs_attention: 'The driver reported an issue on this item.',
});
export const DVIR_ISSUE_SEVERITIES = Object.freeze(['minor', 'major', 'critical']);
export function isDvirIssueSeverity(v) {
    return typeof v === 'string' && DVIR_ISSUE_SEVERITIES.includes(v);
}
export const DVIR_ASSET_ROLES = Object.freeze(['truck', 'trailer']);
export const DVIR_ATTESTATION_KINDS = Object.freeze(['typed_name']);
export const DVIR_COMPLETION_OUTCOMES = Object.freeze(['accepted']);
// ── legacy category projection (compatibility axis, NOT a result vocabulary) ──
/**
 * The nine Dashboard phase-1a categories. In 0.2.0 the ITEM model is
 * canonical; this axis is a projection derived from each item's
 * `legacyCategoryId`, kept so the existing category-based service and its
 * client mirror can be adapted rather than competing with the protocol.
 */
export const DVIR_LEGACY_CATEGORY_IDS = Object.freeze([
    'lights', 'brakes', 'tires', 'emergency_equipment', 'fluid_leaks',
    'tank', 'hoses', 'pto', 'miscellaneous',
]);
export function isDvirLegacyCategoryId(v) {
    return typeof v === 'string' && DVIR_LEGACY_CATEGORY_IDS.includes(v);
}
// ── bounds (shared: validators, callables, and rule tests use THESE) ─────
export const DVIR_BOUNDS = Object.freeze({
    /** Explanations are REQUIRED on needs_attention (vc51.9E decision 1) and
     *  bounded here, in the shared domain — never only by a UI maxLength. */
    explanationMin: 1,
    explanationMax: 500,
    idMax: 120,
    labelMax: 200,
    maxAssets: 2,
    maxAreas: 40,
    maxItemsPerArea: 60,
    maxTotalItems: 400,
    maxIssues: 100,
    maxEvidenceRefsPerIssue: 10,
    signerDisplayNameMax: 120,
    timezoneMax: 64,
    reasonMax: 300,
});
/** Canonical explanation normalization — collapse whitespace, trim.
 *  Shared so every consumer normalizes identically before hashing. */
export function normalizeDvirExplanation(raw) {
    return raw.replace(/\s+/g, ' ').trim();
}
// ── shared string/id guards ──────────────────────────────────────────────
export function isBoundedId(v) {
    return typeof v === 'string' && v.trim().length > 0 && v.length <= DVIR_BOUNDS.idMax;
}
export function isBoundedLabel(v, max = DVIR_BOUNDS.labelMax) {
    return typeof v === 'string' && v.length <= max;
}
export function isIsoTimestamp(v) {
    return typeof v === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(v)
        && !Number.isNaN(Date.parse(v));
}
/** Raw binary / data URLs are forbidden everywhere in this protocol. */
export function containsBinaryPayload(v) {
    return typeof v === 'string' && /^\s*data:/i.test(v);
}
//# sourceMappingURL=protocol.js.map