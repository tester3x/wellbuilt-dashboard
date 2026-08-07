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
import { type DvirAssetRole, type DvirAttestationKind, type DvirIssueSeverity, type DvirItemResult, type DvirLegacyCategoryId, type DvirPhase } from './protocol.js';
export interface DvirEvidenceAsset {
    assetId: string;
    role: DvirAssetRole;
    unitNumber?: string;
    label?: string;
}
export interface DvirEvidenceItem {
    itemId: string;
    componentLabel: string;
    assetId: string;
    result: DvirItemResult;
    /** Compatibility projection axis — never a competing result vocabulary. */
    legacyCategoryId?: DvirLegacyCategoryId;
    /** Present iff result === 'needs_attention'. */
    issueId?: string;
}
export interface DvirEvidenceArea {
    areaId: string;
    label: string;
    assetId: string;
    assetRole: DvirAssetRole;
    items: DvirEvidenceItem[];
}
export interface DvirEvidenceIssue {
    issueId: string;
    assetId: string;
    areaId: string;
    itemId: string;
    componentLabel: string;
    severity: DvirIssueSeverity;
    /** REQUIRED, non-blank, normalized, bounded (vc51.9E decision 1). */
    explanation: string;
    reportedAtClient: string;
}
export interface DvirEvidenceAttestation {
    kind: DvirAttestationKind;
    /** Driver's typed legal name. PII — full-evidence access only; never in
     *  the lightweight view or a deep link (vc51.9E decision 3). */
    signerDisplayName: string;
    /** Client-CLAIMED legacy signer id (driverHash). Retained only for
     *  mismatch detection against server-derived identity; NEVER authority. */
    claimedSignerId?: string;
    signedAtClient: string;
    acknowledgementAccepted: true;
    acknowledgementTextVersion?: string;
}
export interface DvirLegacyCategoryProjection {
    categoryId: DvirLegacyCategoryId;
    /** needs_attention if ANY item in the category needs attention. */
    result: DvirItemResult;
}
export interface DvirNormalizedEvidence {
    phase: DvirPhase;
    inspectionRecordId: string;
    catalogId: string;
    catalogVersion: string;
    assets: DvirEvidenceAsset[];
    areas: DvirEvidenceArea[];
    issues: DvirEvidenceIssue[];
    attestation: DvirEvidenceAttestation;
    noDefects: boolean;
    timezone: string;
    observedStartedAtClient: string;
    observedCompletedAtClient: string;
    legacyCategories?: DvirLegacyCategoryProjection[];
}
export declare const DVIR_EVIDENCE_KEYS: readonly string[];
export declare const DVIR_EVIDENCE_REQUIRED_KEYS: readonly string[];
export declare const DVIR_EVIDENCE_ASSET_KEYS: readonly string[];
export declare const DVIR_EVIDENCE_AREA_KEYS: readonly string[];
export declare const DVIR_EVIDENCE_ITEM_KEYS: readonly string[];
export declare const DVIR_EVIDENCE_ISSUE_KEYS: readonly string[];
export declare const DVIR_EVIDENCE_ATTESTATION_KEYS: readonly string[];
export type DvirEvidenceRejection = 'not_object' | 'unknown_fields' | 'missing_fields' | 'invalid_phase' | 'invalid_inspection_record_id' | 'invalid_catalog' | 'invalid_assets' | 'truck_asset_required' | 'too_many_assets' | 'duplicate_asset' | 'invalid_areas' | 'too_many_areas' | 'too_many_items' | 'duplicate_item' | 'invalid_item' | 'item_asset_mismatch' | 'unknown_legacy_category' | 'invalid_issues' | 'too_many_issues' | 'duplicate_issue' | 'issue_target_missing' | 'issue_without_needs_attention' | 'needs_attention_without_issue' | 'explanation_required' | 'explanation_too_long' | 'invalid_attestation' | 'attestation_not_accepted' | 'binary_payload_forbidden' | 'invalid_timestamps' | 'timestamp_order' | 'invalid_timezone' | 'no_defects_contradiction' | 'legacy_projection_mismatch';
export interface DvirEvidenceResult {
    ok: boolean;
    reason?: DvirEvidenceRejection;
    detail?: string;
    /** Normalized copy (explanations collapsed/trimmed) on success. */
    evidence?: DvirNormalizedEvidence;
}
/**
 * THE canonical evidence validator. One implementation; Functions,
 * eQuipment, WB-S, and the conformance matrix all call this.
 */
export declare function validateDvirNormalizedEvidence(raw: unknown): DvirEvidenceResult;
/**
 * Project the canonical item model onto the nine legacy categories.
 * A category is `needs_attention` if ANY of its items is. The item model
 * stays canonical; this exists purely so the phase-1a category service
 * and its Dashboard client mirror can be adapted, not duplicated.
 */
export declare function computeLegacyCategoryProjection(areas: readonly DvirEvidenceArea[]): DvirLegacyCategoryProjection[];
/**
 * Canonical, order-stable serialization for digests. Consumers MUST use
 * this (never JSON.stringify of the raw object) so a digest computed in
 * eQuipment matches one recomputed server-side.
 *
 * NOTE: a digest proves the submitted body was not altered in transit —
 * it does NOT authenticate the submitter and is never authority.
 */
export declare function canonicalDvirEvidenceString(e: DvirNormalizedEvidence): string;
//# sourceMappingURL=evidence.d.ts.map