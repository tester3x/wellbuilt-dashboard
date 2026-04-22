import type {
  LocationConvergenceDisposition,
  LocationConvergencePreview,
  LocationReviewDisposition,
  LocationTrustLevel,
} from './types.locationHealth';

// Phase 15 — local threshold. Alias-conflict count at-or-above this rejects
// outright. Chosen per spec §3.B (rejected if aliasConflictCount >= 6).
// This is stricter than Phase 13's exclusion rule (>6) on purpose: Phase 15
// represents human-review intent and should be conservative.
const LARGE_ALIAS_REJECT_THRESHOLD = 6;

export interface LocationReviewDispositionInput {
  convergenceDisposition: LocationConvergenceDisposition;
  locationTrustLevel: LocationTrustLevel;
  isStableIdentity: boolean;
  aliasConflictCount: number;
  potentialDrift: boolean;
  isFallbackOnly: boolean;
  convergencePreview?: LocationConvergencePreview;
}

export interface LocationReviewDispositionResult {
  disposition: LocationReviewDisposition;
  reasons: string[];
  isEligible: boolean;
}

/**
 * Phase 15 — derive review disposition from existing Phase 11-14 facts.
 * NOT stored. NOT persisted. Always recomputed from the diagnostic.
 *
 * Rule order (spec §3):
 *   1. REJECTED — ANY of: exclude / low trust / drift / aliasConflict>=6
 *      / fallback-only. Checked first so rejection dominates even if a
 *      caller somehow passes contradictory Phase 13/14 state (defensive).
 *   2. APPROVED — ALL: candidate + high trust + stable + 0 conflicts +
 *      !drift + convergencePreview present + previewConflictFlags empty.
 *   3. UNREVIEWED — everything else (typically hold, or candidate with
 *      preview-level conflicts).
 *
 * APPROVED and REJECTED are mutually exclusive under current Phase 12/13
 * rules (a candidate can never be low-trust / drifting / fallback-only /
 * have aliasConflictCount >= 6). The rule-ordering discipline exists so
 * future Phase 13 tuning can't silently turn a rejected identity into an
 * approved one.
 *
 * Custom / operational / pad / yard locations stay protected: they land in
 * Phase 13 "exclude", which Phase 15 maps to "rejected" — meaning "do not
 * converge", NOT "invalid" or "hide". Downstream consumers should still
 * render these fully.
 */
export function deriveLocationReviewDisposition(
  input: LocationReviewDispositionInput
): LocationReviewDispositionResult {
  const isEligible = input.convergenceDisposition !== 'exclude';

  // --- A) REJECTED --------------------------------------------------------
  // Accumulate in spec §4 vocabulary order for deterministic output.
  const rejected: string[] = [];
  if (input.convergenceDisposition === 'exclude') {
    rejected.push('excluded from convergence');
  }
  if (input.locationTrustLevel === 'low') {
    rejected.push('low trust identity');
  }
  if (input.potentialDrift === true) {
    rejected.push('potential drift detected');
  }
  if (input.isFallbackOnly === true) {
    rejected.push('fallback-only location');
  }
  if (input.aliasConflictCount >= LARGE_ALIAS_REJECT_THRESHOLD) {
    rejected.push('large alias group');
  }
  if (rejected.length > 0) {
    return {
      disposition: 'rejected',
      // Dedup defensively in case a future rule fires the same reason twice.
      reasons: Array.from(new Set(rejected)),
      isEligible,
    };
  }

  // --- B) APPROVED --------------------------------------------------------
  const preview = input.convergencePreview;
  if (
    input.convergenceDisposition === 'candidate' &&
    input.locationTrustLevel === 'high' &&
    input.isStableIdentity === true &&
    input.aliasConflictCount === 0 &&
    input.potentialDrift !== true &&
    preview !== undefined &&
    preview.previewConflictFlags.length === 0
  ) {
    return {
      disposition: 'approved',
      reasons: [
        'high trust candidate',
        'stable identity',
        'no alias conflicts',
        'eligible for convergence',
      ],
      isEligible,
    };
  }

  // --- C) UNREVIEWED (fallthrough) ----------------------------------------
  // Candidate that survived REJECTED but didn't qualify for APPROVED is
  // almost always a candidate whose preview surfaced conflict flags.
  // Everything else lands on "requires human review" — the classic hold case.
  const reasons: string[] = [];
  if (
    input.convergenceDisposition === 'candidate' &&
    preview !== undefined &&
    preview.previewConflictFlags.length > 0
  ) {
    reasons.push('preview conflicts present');
  } else {
    reasons.push('requires human review');
  }
  return { disposition: 'unreviewed', reasons, isEligible };
}
