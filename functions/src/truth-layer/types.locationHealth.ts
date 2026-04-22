import type { LocationRef } from './types';
import type {
  LocationIdentityConfidence,
  LocationSourceKinds,
} from './canonicalLocationIdentity';

/**
 * Phase 12 — passive trust-level signal. Derived only, never authoritative.
 *
 *   high      — strong confidence AND no alias conflicts
 *   moderate  — medium confidence OR small alias grouping
 *   low       — otherwise (weak / fallback-only / large alias grouping)
 *
 * Display/diagnostics only. NOT used in routing, matching, or any behavior.
 */
export type LocationTrustLevel = 'high' | 'moderate' | 'low';

/**
 * Phase 13 — convergence candidate disposition. Review-queue signal only.
 *
 *   candidate — safe to consider for future human-guided convergence
 *   hold      — official-backed but not clean enough, or unclear; needs review
 *   exclude   — do NOT converge (custom, fallback-only, drifting, or risky)
 *
 * Diagnostics/review only. NEVER drives merging, rewrites, or runtime logic.
 */
export type LocationConvergenceDisposition = 'candidate' | 'hold' | 'exclude';

/**
 * Phase 14 — preview-only simulation of what convergence WOULD look like
 * if approved later. Attached only to eligible dispositions (candidate /
 * hold). Never drives merging, rewrites, or live behavior.
 *
 *   unifiedDisplayName    — the anchor display name the preview would use
 *   aliasCollapseCount    — how many aliases would collapse into the anchor
 *   wouldCollapseAliases  — shorthand: aliasCollapseCount > 0
 *   previewConflictFlags  — short factual flags surfacing preview-only risks
 *
 * Exclude-disposition diagnostics do NOT receive this block. They remain
 * fully visible elsewhere; they just aren't part of the review queue today.
 */
export interface LocationConvergencePreview {
  unifiedDisplayName: string;
  aliasCollapseCount: number;
  wouldCollapseAliases: boolean;
  previewConflictFlags: string[];
}

/**
 * Phase 15 — derived review disposition. This is NOT persisted — it's
 * computed from existing diagnostic facts on every build. Models what a
 * reviewer WOULD decide; never drives merging, writes, or runtime logic.
 *
 *   approved   — strict: clean candidate with zero preview conflicts
 *   rejected   — excluded, drifting, low trust, fallback-only, or
 *                large alias group (>=6 conflicts)
 *   unreviewed — everything else (typically hold, or candidate with
 *                preview-level conflicts that need human eyes)
 */
export type LocationReviewDisposition = 'unreviewed' | 'approved' | 'rejected';

/**
 * Phase 16 — controlled application layer. Derived, read-only hook for
 * downstream consumers who want a safe "effective identity" to render /
 * reference for approved locations. Attached only when
 * `reviewDisposition === 'approved'`. Nothing here rewrites the source of
 * truth — the raw canonical key, preferred name, and aliases all remain
 * unchanged and authoritative on the diagnostic.
 *
 *   effectiveLocationKey         — the key a read-only consumer could use
 *   effectiveDisplayName         — a safe display string for UI/reports
 *   appliedByRule                — always 'approved_review' this phase
 *   sourceCanonicalLocationKey   — the exact canonical key the derivation
 *                                  was sourced from (never synthesized)
 */
export interface LocationEffectiveConvergence {
  effectiveLocationKey: string;
  effectiveDisplayName: string;
  /**
   * Which rule attached this block.
   *   - 'approved_review'  : Phase 16 derived (clean candidate + approved)
   *   - 'manual_approval'  : Phase 17 admin override (persisted approval)
   */
  appliedByRule: 'approved_review' | 'manual_approval';
  sourceCanonicalLocationKey: string;
}

/**
 * Phase 17 — persisted human approval of a canonical location. Minimal,
 * factual. Stored by the admin-gated `approveTruthLocation` callable in
 * RTDB at `truth_overrides/location_approvals/{scope}/{safeKey}`.
 *
 * Reading paths fold this in AFTER the derived Phase 12-16 facts to
 * override `reviewDisposition` and attach `effectiveConvergence`. The
 * derived facts themselves (confidence, trust level, convergence
 * disposition, reasons, preview flags) are preserved visible — the
 * admin sees why the row WOULD have been rejected alongside the
 * override.
 */
export interface LocationManualApproval {
  canonicalLocationKey: string;
  approvedDisplayName: string;
  approvedByUid: string;
  approvedByEmail?: string;
  approvedAt: string; // ISO 8601
  companyScope: string; // companyId or '_global'
  active: boolean;
  // Phase 19 — optional revoke audit trail. Set by revokeTruthLocationApproval
  // when `active` flips to false. Preserved through subsequent re-approves
  // (the approve callable writes a fresh record via `.set()`, so these
  // fields disappear when the admin re-approves — fresh approval, fresh
  // timestamp). Soft-delete by design; source-of-truth audit stays in RTDB.
  revokedAt?: string; // ISO 8601
  revokedByUid?: string;
  revokedByEmail?: string;
}

export interface LocationIdentityDiagnostic {
  canonicalLocationKey: string;
  preferredName: string;
  aliases: string[];
  aliasCount: number;
  kind?: LocationRef['kind'];
  confidence: LocationIdentityConfidence;
  sourceKinds: LocationSourceKinds;
  reasons: string[];
  isCustomOnly: boolean;
  isOfficialBacked: boolean;
  isMergedAliasSet: boolean;
  // Phase 12 — passive trust signals. Additive; never change behavior.
  isStableIdentity: boolean;
  aliasConflictCount: number;
  hasMixedSourceKinds: boolean;
  locationTrustLevel: LocationTrustLevel;
  potentialDrift?: boolean;
  // Phase 13 — passive convergence review signals. Additive; never merge.
  // hasOfficialBacking mirrors isOfficialBacked (kept under the Phase 13
  // naming convention) and isFallbackOnly mirrors isCustomOnly. Both names
  // coexist intentionally — old consumers stay green, new consumers can read
  // the convergence-oriented names without re-deriving from sourceKinds.
  hasOfficialBacking: boolean;
  isFallbackOnly: boolean;
  aliasDiversity: number;
  convergenceDisposition: LocationConvergenceDisposition;
  convergenceReasons: string[];
  // Phase 14 — preview-only simulation. Present when disposition ∈
  // { candidate, hold }; absent for exclude. Informational only.
  convergencePreview?: LocationConvergencePreview;
  // Phase 15 — derived human-review classification. NOT persisted; always
  // recomputed. Informational/review-queue signal only.
  reviewDisposition: LocationReviewDisposition;
  reviewReasons: string[];
  isReviewEligible: boolean;
  // Phase 16 — derived effective identity for approved locations only.
  // Absent for everything else. Read-only hook; never rewrites source truth.
  effectiveConvergence?: LocationEffectiveConvergence;
  // Phase 17 — persisted manual approval flags. Present only when a
  // matching `LocationManualApproval` record was found for this canonical
  // key. The underlying derived facts (confidence, convergence disposition,
  // reasons, preview flags) remain visible on the same diagnostic.
  manuallyApproved?: boolean;
  manualApprovalAt?: string; // ISO 8601 — mirrors LocationManualApproval.approvedAt
}

export interface LocationHealthSummary {
  totalCanonicalLocations: number;
  strongCount: number;
  mediumCount: number;
  weakCount: number;
  customOnlyCount: number;
  officialBackedCount: number;
  mergedAliasCount: number;
}

export interface LocationHealthView {
  summary: LocationHealthSummary;
  diagnostics: LocationIdentityDiagnostic[];
  generatedAt: string;
}

export interface TopAliasGroup {
  canonicalLocationKey: string;
  preferredName: string;
  aliasCount: number;
  aliases: string[];
  kind?: LocationRef['kind'];
  confidence: LocationIdentityConfidence;
}

export interface CustomOnlyLocationEntry {
  canonicalLocationKey: string;
  preferredName: string;
  kind?: LocationRef['kind'];
  reasons: string[];
}

/**
 * Phase 12 — lean per-bucket counts for canonical location trust.
 * Informational only. No severity scoring, no headline status.
 */
export interface LocationTrustCounts {
  stableCount: number;
  unstableCount: number;
  highTrustCount: number;
  moderateTrustCount: number;
  lowTrustCount: number;
  driftCount: number;
}

/**
 * Phase 13 — lean per-bucket counts for the convergence review queue.
 * Informational only. No severity scoring, no headline status.
 *
 * `officialBackedCandidateCount` and `fallbackOnlyExcludeCount` are
 * narrower cuts surfaced alongside the primary disposition counts so
 * admins can spot-check the two most important buckets without
 * iterating diagnostics themselves.
 */
export interface LocationConvergenceCounts {
  candidate: number;
  hold: number;
  exclude: number;
  officialBackedCandidateCount: number;
  fallbackOnlyExcludeCount: number;
}

/**
 * Phase 14 — lean preview counts for the review queue.
 *   previewableCount     — diagnostics with a convergencePreview attached
 *   previewConflictCount — diagnostics whose preview surfaced any flags
 * Informational only. Preview never triggers merging or writes.
 */
export interface LocationConvergencePreviewCounts {
  previewableCount: number;
  previewConflictCount: number;
}

/**
 * Phase 15 — lean review-disposition counts. Informational only.
 * approved + rejected + unreviewed === totalCanonicalLocations.
 */
export interface LocationReviewCounts {
  approved: number;
  rejected: number;
  unreviewed: number;
}

/**
 * Phase 16 — lean effective-convergence counts.
 *   appliedCount    — diagnostics with an effectiveConvergence block
 *   unappliedCount  — diagnostics without one
 * applied + unapplied === totalCanonicalLocations. Informational only.
 */
export interface LocationEffectiveConvergenceCounts {
  appliedCount: number;
  unappliedCount: number;
}

export interface LocationHealthDashboardSummary {
  summary: LocationHealthSummary;
  topAliasGroups: TopAliasGroup[];
  customOnlyLocations: CustomOnlyLocationEntry[];
  // Phase 12 — passive trust counts surfaced alongside existing aggregates.
  trustCounts: LocationTrustCounts;
  // Phase 13 — passive convergence review counts. Review queue signal only.
  convergenceCounts: LocationConvergenceCounts;
  // Phase 14 — lean preview counts alongside the disposition counts.
  convergencePreviewCounts: LocationConvergencePreviewCounts;
  // Phase 15 — derived review counts. Never persisted; recomputed on build.
  reviewCounts: LocationReviewCounts;
  // Phase 16 — derived application-layer counts. Never persisted; recomputed.
  effectiveConvergenceCounts: LocationEffectiveConvergenceCounts;
  generatedAt: string;
}
