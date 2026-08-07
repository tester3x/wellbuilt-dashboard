/**
 * Canonical normalized DVIR evidence (vc51.9E).
 *
 * Derived field-by-field from the established eQuipment domain
 * (packages/dvir-domain) — NOT invented:
 *
 *   areas[].items[]     ← SessionArea / SessionItem (models/types.ts:99-118)
 *                          and the sealed report snapshot (:333-345)
 *   result              ← ItemResult, with the domain's implicit pass
 *                          (engine.ts nextArea bulk-resolve) named honestly
 *                          as `pass_by_area_completion`
 *   issues[]            ← ReportedIssue (types.ts:156-166), severity only
 *   explanation         ← ReportedIssue.notes — REQUIRED here by approved
 *                          vc51.9E decision 1 (the app is optional today;
 *                          this defines the eQuipment behavior correction)
 *   attestation         ← SignatureMetadata (types.ts:177-187), typed name
 *   assets[]            ← AssetRef (types.ts:32-44), truck required, max 2
 *   legacyCategories[]  ← projection of item.legacyCategoryId
 *
 * DELIBERATELY EXCLUDED:
 *   timeline[]  — device event log, unbounded, and duplicated 3-4x inside
 *                 the sealed report (report.ts:150 → both phases of
 *                 ShiftDvirRecord). Not evidence of the inspection.
 *   PDFs/photos/signature images — binary never enters this protocol;
 *                 immutable references/digests only, where established.
 *   currentAreaIndex / sync + pdf meta — device bookkeeping.
 *
 * TIMESTAMPS: every field here is CLIENT-OBSERVED and named `...Client`.
 * Only the server may stamp `acceptedAtServer` (see records.ts).
 */
import { DVIR_BOUNDS, containsBinaryPayload, isBoundedId, isBoundedLabel, isDvirIssueSeverity, isDvirItemResult, isDvirLegacyCategoryId, isDvirPhase, isIsoTimestamp, normalizeDvirExplanation, } from './protocol.js';
// ── exact key sets (Functions validators + rule-source pins) ─────────────
export const DVIR_EVIDENCE_KEYS = Object.freeze([
    'phase', 'inspectionRecordId', 'catalogId', 'catalogVersion', 'assets', 'areas',
    'issues', 'attestation', 'noDefects', 'timezone',
    'observedStartedAtClient', 'observedCompletedAtClient', 'legacyCategories',
]);
export const DVIR_EVIDENCE_REQUIRED_KEYS = Object.freeze([
    'phase', 'inspectionRecordId', 'catalogId', 'catalogVersion', 'assets', 'areas',
    'issues', 'attestation', 'noDefects', 'timezone',
    'observedStartedAtClient', 'observedCompletedAtClient',
]);
export const DVIR_EVIDENCE_ASSET_KEYS = Object.freeze(['assetId', 'role', 'unitNumber', 'label']);
export const DVIR_EVIDENCE_AREA_KEYS = Object.freeze(['areaId', 'label', 'assetId', 'assetRole', 'items']);
export const DVIR_EVIDENCE_ITEM_KEYS = Object.freeze([
    'itemId', 'componentLabel', 'assetId', 'result', 'legacyCategoryId', 'issueId',
]);
export const DVIR_EVIDENCE_ISSUE_KEYS = Object.freeze([
    'issueId', 'assetId', 'areaId', 'itemId', 'componentLabel', 'severity',
    'explanation', 'reportedAtClient',
]);
export const DVIR_EVIDENCE_ATTESTATION_KEYS = Object.freeze([
    'kind', 'signerDisplayName', 'claimedSignerId', 'signedAtClient',
    'acknowledgementAccepted', 'acknowledgementTextVersion',
]);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (reason, detail) => ({ ok: false, reason, ...(detail ? { detail } : {}) });
const exactKeys = (o, allowed) => Object.keys(o).filter((k) => !allowed.includes(k));
/**
 * THE canonical evidence validator. One implementation; Functions,
 * eQuipment, WB-S, and the conformance matrix all call this.
 */
export function validateDvirNormalizedEvidence(raw) {
    if (!isObj(raw))
        return fail('not_object');
    const unknown = exactKeys(raw, DVIR_EVIDENCE_KEYS);
    if (unknown.length)
        return fail('unknown_fields', unknown.join(','));
    const missing = DVIR_EVIDENCE_REQUIRED_KEYS.filter((k) => raw[k] === undefined);
    if (missing.length)
        return fail('missing_fields', missing.join(','));
    if (!isDvirPhase(raw.phase))
        return fail('invalid_phase');
    if (!isBoundedId(raw.inspectionRecordId))
        return fail('invalid_inspection_record_id');
    if (!isBoundedId(raw.catalogId) || !isBoundedLabel(raw.catalogVersion, DVIR_BOUNDS.idMax)
        || typeof raw.catalogVersion !== 'string' || raw.catalogVersion.length === 0) {
        return fail('invalid_catalog');
    }
    if (typeof raw.timezone !== 'string' || raw.timezone.length === 0
        || raw.timezone.length > DVIR_BOUNDS.timezoneMax) {
        return fail('invalid_timezone');
    }
    if (typeof raw.noDefects !== 'boolean')
        return fail('missing_fields', 'noDefects');
    if (!isIsoTimestamp(raw.observedStartedAtClient) || !isIsoTimestamp(raw.observedCompletedAtClient)) {
        return fail('invalid_timestamps');
    }
    if (Date.parse(raw.observedCompletedAtClient) < Date.parse(raw.observedStartedAtClient)) {
        return fail('timestamp_order');
    }
    // ── assets: truck required, max 2, unique ids and roles ────────────────
    if (!Array.isArray(raw.assets) || raw.assets.length === 0)
        return fail('invalid_assets');
    if (raw.assets.length > DVIR_BOUNDS.maxAssets)
        return fail('too_many_assets');
    const assetIds = new Set();
    const roles = new Set();
    for (const a of raw.assets) {
        if (!isObj(a))
            return fail('invalid_assets');
        if (exactKeys(a, DVIR_EVIDENCE_ASSET_KEYS).length)
            return fail('unknown_fields', 'asset');
        if (!isBoundedId(a.assetId))
            return fail('invalid_assets', 'assetId');
        if (a.role !== 'truck' && a.role !== 'trailer')
            return fail('invalid_assets', 'role');
        if (a.unitNumber !== undefined && !isBoundedLabel(a.unitNumber))
            return fail('invalid_assets', 'unitNumber');
        if (a.label !== undefined && !isBoundedLabel(a.label))
            return fail('invalid_assets', 'label');
        if (assetIds.has(a.assetId))
            return fail('duplicate_asset', a.assetId);
        if (roles.has(a.role))
            return fail('invalid_assets', 'duplicate role');
        assetIds.add(a.assetId);
        roles.add(a.role);
    }
    if (!roles.has('truck'))
        return fail('truck_asset_required');
    // ── areas + items ──────────────────────────────────────────────────────
    if (!Array.isArray(raw.areas) || raw.areas.length === 0)
        return fail('invalid_areas');
    if (raw.areas.length > DVIR_BOUNDS.maxAreas)
        return fail('too_many_areas');
    const itemIds = new Set();
    const needsAttentionItems = new Map();
    let totalItems = 0;
    const areaIds = new Set();
    for (const area of raw.areas) {
        if (!isObj(area))
            return fail('invalid_areas');
        if (exactKeys(area, DVIR_EVIDENCE_AREA_KEYS).length)
            return fail('unknown_fields', 'area');
        if (!isBoundedId(area.areaId) || !isBoundedLabel(area.label))
            return fail('invalid_areas', 'areaId/label');
        if (areaIds.has(area.areaId))
            return fail('invalid_areas', 'duplicate areaId');
        areaIds.add(area.areaId);
        if (!assetIds.has(area.assetId))
            return fail('item_asset_mismatch', 'area.assetId');
        if (area.assetRole !== 'truck' && area.assetRole !== 'trailer')
            return fail('invalid_areas', 'assetRole');
        if (!Array.isArray(area.items) || area.items.length === 0)
            return fail('invalid_areas', 'items');
        if (area.items.length > DVIR_BOUNDS.maxItemsPerArea)
            return fail('too_many_items', area.areaId);
        for (const item of area.items) {
            totalItems++;
            if (totalItems > DVIR_BOUNDS.maxTotalItems)
                return fail('too_many_items');
            if (!isObj(item))
                return fail('invalid_item');
            if (exactKeys(item, DVIR_EVIDENCE_ITEM_KEYS).length)
                return fail('unknown_fields', 'item');
            if (!isBoundedId(item.itemId) || !isBoundedLabel(item.componentLabel))
                return fail('invalid_item');
            if (!isDvirItemResult(item.result))
                return fail('invalid_item', 'result');
            // Item asset attribution must match its own area (domain invariant).
            if (item.assetId !== area.assetId)
                return fail('item_asset_mismatch', item.itemId);
            if (itemIds.has(item.itemId))
                return fail('duplicate_item', item.itemId);
            itemIds.add(item.itemId);
            if (item.legacyCategoryId !== undefined && !isDvirLegacyCategoryId(item.legacyCategoryId)) {
                return fail('unknown_legacy_category', String(item.legacyCategoryId));
            }
            if (item.result === 'needs_attention') {
                if (item.issueId !== undefined && !isBoundedId(item.issueId))
                    return fail('invalid_item', 'issueId');
                needsAttentionItems.set(item.itemId, {
                    areaId: area.areaId,
                    assetId: area.assetId,
                    issueId: item.issueId,
                });
            }
            else if (item.issueId !== undefined) {
                return fail('issue_without_needs_attention', item.itemId);
            }
        }
    }
    // ── issues: one per needs_attention item, explanation REQUIRED ─────────
    if (!Array.isArray(raw.issues))
        return fail('invalid_issues');
    if (raw.issues.length > DVIR_BOUNDS.maxIssues)
        return fail('too_many_issues');
    const issueIds = new Set();
    const issuesByItem = new Map();
    const normalizedIssues = [];
    for (const iss of raw.issues) {
        if (!isObj(iss))
            return fail('invalid_issues');
        if (exactKeys(iss, DVIR_EVIDENCE_ISSUE_KEYS).length)
            return fail('unknown_fields', 'issue');
        if (!isBoundedId(iss.issueId))
            return fail('invalid_issues', 'issueId');
        if (issueIds.has(iss.issueId))
            return fail('duplicate_issue', iss.issueId);
        issueIds.add(iss.issueId);
        if (!isBoundedId(iss.itemId) || !isBoundedId(iss.areaId) || !isBoundedId(iss.assetId)) {
            return fail('invalid_issues', 'target ids');
        }
        if (!isBoundedLabel(iss.componentLabel))
            return fail('invalid_issues', 'componentLabel');
        if (!isDvirIssueSeverity(iss.severity))
            return fail('invalid_issues', 'severity');
        if (!isIsoTimestamp(iss.reportedAtClient))
            return fail('invalid_timestamps', 'reportedAtClient');
        // vc51.9E decision 1 — a non-blank bounded explanation is REQUIRED.
        if (typeof iss.explanation !== 'string')
            return fail('explanation_required', iss.itemId);
        if (containsBinaryPayload(iss.explanation))
            return fail('binary_payload_forbidden', 'explanation');
        const explanation = normalizeDvirExplanation(iss.explanation);
        if (explanation.length < DVIR_BOUNDS.explanationMin)
            return fail('explanation_required', iss.itemId);
        if (explanation.length > DVIR_BOUNDS.explanationMax)
            return fail('explanation_too_long', iss.itemId);
        const target = needsAttentionItems.get(iss.itemId);
        if (!target)
            return fail('issue_target_missing', iss.itemId);
        if (target.areaId !== iss.areaId || target.assetId !== iss.assetId) {
            return fail('item_asset_mismatch', iss.issueId);
        }
        if (target.issueId !== undefined && target.issueId !== iss.issueId) {
            return fail('duplicate_issue', `item ${iss.itemId} points at ${target.issueId}`);
        }
        if (issuesByItem.has(iss.itemId))
            return fail('duplicate_issue', iss.itemId);
        issuesByItem.set(iss.itemId, iss);
        normalizedIssues.push({
            issueId: iss.issueId,
            assetId: iss.assetId,
            areaId: iss.areaId,
            itemId: iss.itemId,
            componentLabel: iss.componentLabel,
            severity: iss.severity,
            explanation,
            reportedAtClient: iss.reportedAtClient,
        });
    }
    for (const [itemId] of needsAttentionItems) {
        if (!issuesByItem.has(itemId))
            return fail('needs_attention_without_issue', itemId);
    }
    if (raw.noDefects === true && normalizedIssues.length > 0) {
        return fail('no_defects_contradiction');
    }
    if (raw.noDefects === false && normalizedIssues.length === 0) {
        return fail('no_defects_contradiction', 'noDefects=false with zero issues');
    }
    // ── attestation ────────────────────────────────────────────────────────
    const att = raw.attestation;
    if (!isObj(att))
        return fail('invalid_attestation');
    if (exactKeys(att, DVIR_EVIDENCE_ATTESTATION_KEYS).length)
        return fail('unknown_fields', 'attestation');
    if (att.kind !== 'typed_name')
        return fail('invalid_attestation', 'kind');
    if (typeof att.signerDisplayName !== 'string' || att.signerDisplayName.trim().length === 0
        || att.signerDisplayName.length > DVIR_BOUNDS.signerDisplayNameMax) {
        return fail('invalid_attestation', 'signerDisplayName');
    }
    if (containsBinaryPayload(att.signerDisplayName))
        return fail('binary_payload_forbidden', 'signerDisplayName');
    if (att.claimedSignerId !== undefined && !isBoundedId(att.claimedSignerId)) {
        return fail('invalid_attestation', 'claimedSignerId');
    }
    if (!isIsoTimestamp(att.signedAtClient))
        return fail('invalid_timestamps', 'signedAtClient');
    if (att.acknowledgementAccepted !== true)
        return fail('attestation_not_accepted');
    if (att.acknowledgementTextVersion !== undefined && !isBoundedLabel(att.acknowledgementTextVersion, DVIR_BOUNDS.idMax)) {
        return fail('invalid_attestation', 'acknowledgementTextVersion');
    }
    // ── legacy projection must agree with the canonical item model ─────────
    const projection = computeLegacyCategoryProjection(raw.areas);
    if (raw.legacyCategories !== undefined) {
        if (!Array.isArray(raw.legacyCategories))
            return fail('legacy_projection_mismatch');
        const supplied = new Map();
        for (const c of raw.legacyCategories) {
            if (!isObj(c) || !isDvirLegacyCategoryId(c.categoryId) || !isDvirItemResult(c.result)) {
                return fail('legacy_projection_mismatch');
            }
            if (supplied.has(c.categoryId))
                return fail('legacy_projection_mismatch', 'duplicate');
            supplied.set(c.categoryId, c.result);
        }
        if (supplied.size !== projection.length)
            return fail('legacy_projection_mismatch', 'size');
        for (const p of projection) {
            if (supplied.get(p.categoryId) !== p.result) {
                return fail('legacy_projection_mismatch', p.categoryId);
            }
        }
    }
    const evidence = {
        phase: raw.phase,
        inspectionRecordId: raw.inspectionRecordId,
        catalogId: raw.catalogId,
        catalogVersion: raw.catalogVersion,
        assets: raw.assets,
        areas: raw.areas,
        issues: normalizedIssues,
        attestation: att,
        noDefects: raw.noDefects,
        timezone: raw.timezone,
        observedStartedAtClient: raw.observedStartedAtClient,
        observedCompletedAtClient: raw.observedCompletedAtClient,
        ...(projection.length ? { legacyCategories: projection } : {}),
    };
    return { ok: true, evidence };
}
/**
 * Project the canonical item model onto the nine legacy categories.
 * A category is `needs_attention` if ANY of its items is. The item model
 * stays canonical; this exists purely so the phase-1a category service
 * and its Dashboard client mirror can be adapted, not duplicated.
 */
export function computeLegacyCategoryProjection(areas) {
    const byCategory = new Map();
    for (const area of areas ?? []) {
        for (const item of area.items ?? []) {
            const cat = item.legacyCategoryId;
            if (!cat)
                continue;
            const prior = byCategory.get(cat);
            if (item.result === 'needs_attention' || prior === 'needs_attention') {
                byCategory.set(cat, 'needs_attention');
            }
            else if (!prior) {
                byCategory.set(cat, 'pass_by_area_completion');
            }
        }
    }
    // Canonical ordering — digests over this projection must be stable.
    return [...byCategory.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([categoryId, result]) => ({ categoryId, result }));
}
/**
 * Canonical, order-stable serialization for digests. Consumers MUST use
 * this (never JSON.stringify of the raw object) so a digest computed in
 * eQuipment matches one recomputed server-side.
 *
 * NOTE: a digest proves the submitted body was not altered in transit —
 * it does NOT authenticate the submitter and is never authority.
 */
export function canonicalDvirEvidenceString(e) {
    const sortedAreas = [...e.areas]
        .sort((a, b) => a.areaId.localeCompare(b.areaId))
        .map((area) => ({
        areaId: area.areaId, label: area.label, assetId: area.assetId, assetRole: area.assetRole,
        items: [...area.items].sort((x, y) => x.itemId.localeCompare(y.itemId)).map((i) => ({
            itemId: i.itemId, componentLabel: i.componentLabel, assetId: i.assetId,
            result: i.result,
            legacyCategoryId: i.legacyCategoryId ?? null,
            issueId: i.issueId ?? null,
        })),
    }));
    const sortedIssues = [...e.issues].sort((a, b) => a.issueId.localeCompare(b.issueId));
    const sortedAssets = [...e.assets].sort((a, b) => a.assetId.localeCompare(b.assetId));
    return JSON.stringify({
        phase: e.phase,
        inspectionRecordId: e.inspectionRecordId,
        catalogId: e.catalogId,
        catalogVersion: e.catalogVersion,
        assets: sortedAssets,
        areas: sortedAreas,
        issues: sortedIssues,
        attestation: {
            kind: e.attestation.kind,
            signerDisplayName: e.attestation.signerDisplayName,
            signedAtClient: e.attestation.signedAtClient,
            acknowledgementAccepted: e.attestation.acknowledgementAccepted,
            acknowledgementTextVersion: e.attestation.acknowledgementTextVersion ?? null,
        },
        noDefects: e.noDefects,
        timezone: e.timezone,
        observedStartedAtClient: e.observedStartedAtClient,
        observedCompletedAtClient: e.observedCompletedAtClient,
        legacyCategories: e.legacyCategories ?? [],
    });
}
//# sourceMappingURL=evidence.js.map