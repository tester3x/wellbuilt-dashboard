import type {
  CustomOnlyLocationEntry,
  LocationConvergenceCounts,
  LocationConvergencePreviewCounts,
  LocationEffectiveConvergenceCounts,
  LocationHealthDashboardSummary,
  LocationHealthView,
  LocationIdentityDiagnostic,
  LocationReviewCounts,
  LocationTrustCounts,
  TopAliasGroup,
} from './types.locationHealth';

const DEFAULT_TOP_ALIAS_LIMIT = 10;
const DEFAULT_CUSTOM_ONLY_LIMIT = 20;

export interface BuildLocationHealthDashboardSummaryOptions {
  topAliasLimit?: number;
  customOnlyLimit?: number;
}

/**
 * Phase 12 — lean per-bucket counts of canonical locations. Diagnostics only,
 * no severity scoring. Consumers decide what (if anything) to highlight.
 */
function buildTrustCounts(
  diagnostics: LocationIdentityDiagnostic[]
): LocationTrustCounts {
  const c: LocationTrustCounts = {
    stableCount: 0,
    unstableCount: 0,
    highTrustCount: 0,
    moderateTrustCount: 0,
    lowTrustCount: 0,
    driftCount: 0,
  };
  for (const d of diagnostics) {
    if (d.isStableIdentity) c.stableCount += 1;
    else c.unstableCount += 1;
    if (d.locationTrustLevel === 'high') c.highTrustCount += 1;
    else if (d.locationTrustLevel === 'moderate') c.moderateTrustCount += 1;
    else c.lowTrustCount += 1;
    if (d.potentialDrift) c.driftCount += 1;
  }
  return c;
}

/**
 * Phase 13 — lean per-bucket convergence review counts. Diagnostics only;
 * no severity scoring. candidate + hold + exclude always sums to the total
 * number of diagnostics.
 *
 * `officialBackedCandidateCount` and `fallbackOnlyExcludeCount` are narrower
 * cuts surfaced alongside the primary disposition counts — the two most
 * important sub-buckets for human review.
 */
function buildConvergenceCounts(
  diagnostics: LocationIdentityDiagnostic[]
): LocationConvergenceCounts {
  const c: LocationConvergenceCounts = {
    candidate: 0,
    hold: 0,
    exclude: 0,
    officialBackedCandidateCount: 0,
    fallbackOnlyExcludeCount: 0,
  };
  for (const d of diagnostics) {
    if (d.convergenceDisposition === 'candidate') {
      c.candidate += 1;
      if (d.hasOfficialBacking) c.officialBackedCandidateCount += 1;
    } else if (d.convergenceDisposition === 'hold') {
      c.hold += 1;
    } else {
      c.exclude += 1;
      if (d.isFallbackOnly) c.fallbackOnlyExcludeCount += 1;
    }
  }
  return c;
}

/**
 * Phase 14 — lean preview counts. Informational only.
 *   previewableCount     = diagnostics with a convergencePreview block
 *   previewConflictCount = previewable diagnostics whose preview surfaced
 *                          at least one flag
 * Preview-flagged ⊆ previewable; previewable ⊆ total. Exclude diagnostics
 * never contribute to either count (they carry no preview block).
 */
function buildConvergencePreviewCounts(
  diagnostics: LocationIdentityDiagnostic[]
): LocationConvergencePreviewCounts {
  const c: LocationConvergencePreviewCounts = {
    previewableCount: 0,
    previewConflictCount: 0,
  };
  for (const d of diagnostics) {
    if (d.convergencePreview) {
      c.previewableCount += 1;
      if (d.convergencePreview.previewConflictFlags.length > 0) {
        c.previewConflictCount += 1;
      }
    }
  }
  return c;
}

/**
 * Phase 15 — lean review-disposition counts. Informational only.
 * approved + rejected + unreviewed always sums to the total number of
 * diagnostics. These counts are derived (not persisted) — every dashboard
 * summary build recomputes them from the current diagnostics.
 */
function buildReviewCounts(
  diagnostics: LocationIdentityDiagnostic[]
): LocationReviewCounts {
  const c: LocationReviewCounts = {
    approved: 0,
    rejected: 0,
    unreviewed: 0,
  };
  for (const d of diagnostics) {
    if (d.reviewDisposition === 'approved') c.approved += 1;
    else if (d.reviewDisposition === 'rejected') c.rejected += 1;
    else c.unreviewed += 1;
  }
  return c;
}

/**
 * Phase 16 — lean applied/unapplied counts for the effective identity hook.
 * Informational only. applied + unapplied === totalCanonicalLocations.
 * Source truth untouched regardless of which bucket a diagnostic lands in.
 */
function buildEffectiveConvergenceCounts(
  diagnostics: LocationIdentityDiagnostic[]
): LocationEffectiveConvergenceCounts {
  const c: LocationEffectiveConvergenceCounts = {
    appliedCount: 0,
    unappliedCount: 0,
  };
  for (const d of diagnostics) {
    if (d.effectiveConvergence) c.appliedCount += 1;
    else c.unappliedCount += 1;
  }
  return c;
}

/**
 * Lean admin-facing surface adapter for location health. Factual — surfaces
 * custom/fallback locations as informational, not as warnings.
 *
 * Phase 12 adds a `trustCounts` block alongside the existing aggregates.
 * Phase 13 adds a `convergenceCounts` block for the review queue. Phase 14
 * adds a `convergencePreviewCounts` block summarizing the preview-only
 * simulation. Phase 15 adds a `reviewCounts` block modeling human-review
 * intent. Phase 16 adds an `effectiveConvergenceCounts` block summarizing
 * the derived application layer. All six blocks are informational;
 * consumers that don't need them can ignore the fields. None are
 * persisted — all are recomputed on every build.
 */
export function buildLocationHealthDashboardSummary(
  view: LocationHealthView,
  options: BuildLocationHealthDashboardSummaryOptions = {}
): LocationHealthDashboardSummary {
  const aliasLimit = options.topAliasLimit ?? DEFAULT_TOP_ALIAS_LIMIT;
  const customLimit = options.customOnlyLimit ?? DEFAULT_CUSTOM_ONLY_LIMIT;

  const topAliasGroups: TopAliasGroup[] = view.diagnostics
    .filter((d) => d.isMergedAliasSet)
    .sort((a, b) => {
      if (b.aliasCount !== a.aliasCount) return b.aliasCount - a.aliasCount;
      return a.canonicalLocationKey.localeCompare(b.canonicalLocationKey);
    })
    .slice(0, aliasLimit)
    .map((d) => {
      const entry: TopAliasGroup = {
        canonicalLocationKey: d.canonicalLocationKey,
        preferredName: d.preferredName,
        aliasCount: d.aliasCount,
        aliases: d.aliases,
        confidence: d.confidence,
      };
      if (d.kind !== undefined) entry.kind = d.kind;
      return entry;
    });

  const customOnlyLocations: CustomOnlyLocationEntry[] = view.diagnostics
    .filter((d) => d.isCustomOnly)
    .sort((a, b) => a.canonicalLocationKey.localeCompare(b.canonicalLocationKey))
    .slice(0, customLimit)
    .map((d) => {
      const entry: CustomOnlyLocationEntry = {
        canonicalLocationKey: d.canonicalLocationKey,
        preferredName: d.preferredName,
        reasons: [...d.reasons],
      };
      if (d.kind !== undefined) entry.kind = d.kind;
      return entry;
    });

  return {
    summary: view.summary,
    topAliasGroups,
    customOnlyLocations,
    trustCounts: buildTrustCounts(view.diagnostics),
    convergenceCounts: buildConvergenceCounts(view.diagnostics),
    convergencePreviewCounts: buildConvergencePreviewCounts(view.diagnostics),
    reviewCounts: buildReviewCounts(view.diagnostics),
    effectiveConvergenceCounts: buildEffectiveConvergenceCounts(view.diagnostics),
    generatedAt: view.generatedAt,
  };
}
