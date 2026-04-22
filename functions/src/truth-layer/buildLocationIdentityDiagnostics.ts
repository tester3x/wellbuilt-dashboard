import type { CanonicalProjection } from './types.canonical';
import type {
  LocationIdentityDiagnostic,
  LocationTrustLevel,
} from './types.locationHealth';
import {
  getLocationConfidence,
  getLocationSourceKinds,
  type LocationSourceKinds,
} from './canonicalLocationIdentity';
import {
  computeAliasDiversity,
  deriveLocationConvergenceDisposition,
} from './deriveLocationConvergenceDisposition';
import { deriveLocationConvergencePreview } from './deriveLocationConvergencePreview';
import { deriveLocationReviewDisposition } from './deriveLocationReviewDisposition';
import { deriveEffectiveLocationConvergence } from './deriveEffectiveLocationConvergence';

// Phase 12 — local trust threshold. Kept inline (not exported) on purpose.
// "Small" alias grouping = up to this many *other* display names sharing the
// canonical key beyond the preferred name. Conservative end of the
// architect's suggested 2-3 range.
const SMALL_ALIAS_GROUP = 3;

/**
 * Phase 12 — count how many source-kind flags are set on the merged view.
 * The current Phase 11 merge collapses kinds in most cases, so this usually
 * returns 0 or 1. Ready for future multi-source preservation.
 */
function countSourceKinds(src: LocationSourceKinds): number {
  let n = 0;
  if (src.hasNdic) n += 1;
  if (src.hasSwd) n += 1;
  if (src.hasWellConfig) n += 1;
  if (src.hasFallbackOnly) n += 1;
  return n;
}

/**
 * Phase 12 — derive trust bucket from confidence + alias conflict count.
 * Display/diagnostics only; never used by canonical resolution or routing.
 *
 *   high      — strong confidence AND no alias conflicts
 *   moderate  — medium confidence OR alias conflicts within SMALL_ALIAS_GROUP
 *   low       — otherwise
 */
function deriveTrustLevel(
  confidence: 'strong' | 'medium' | 'weak',
  aliasConflictCount: number
): LocationTrustLevel {
  if (confidence === 'strong' && aliasConflictCount === 0) return 'high';
  if (confidence === 'medium' || aliasConflictCount <= SMALL_ALIAS_GROUP) {
    return 'moderate';
  }
  return 'low';
}

/**
 * Per-canonical-location diagnostic. Factual only — never flags a custom /
 * fallback location as invalid. Reasons are informational strings suitable
 * for admin UI rendering.
 *
 * Phase 12 adds passive trust signals (isStableIdentity, aliasConflictCount,
 * hasMixedSourceKinds, locationTrustLevel, potentialDrift). These are
 * visibility-only — they never change how locations are resolved, grouped,
 * or displayed downstream.
 *
 * Phase 13 adds passive convergence review signals (hasOfficialBacking,
 * isFallbackOnly, aliasDiversity, convergenceDisposition, convergenceReasons).
 * These classify each canonical location into a future-human-review queue.
 * They never drive merging, rewrites, or any runtime behavior. Custom /
 * pad / yard / fallback-only locations are explicitly protected — they're
 * always classified as "exclude" (never downgraded, never hidden).
 *
 * Phase 14 adds a passive convergencePreview block — a preview-only
 * simulation of what convergence WOULD look like if ever approved.
 * Attached only to candidate/hold diagnostics; exclude diagnostics remain
 * fully visible elsewhere but carry no preview block. Never writes,
 * never merges, never invents names.
 *
 * Phase 15 adds a derived human-review layer (reviewDisposition,
 * reviewReasons, isReviewEligible). These are RECOMPUTED every build —
 * no persistence, no writes, no user-editable state. They model what a
 * reviewer WOULD decide given today's diagnostic facts.
 *
 * Phase 16 adds an optional effectiveConvergence block — a safe derived
 * identity for downstream read-only consumers of approved diagnostics.
 * Present only when reviewDisposition === 'approved'. NEVER rewrites
 * canonicalLocationKey / preferredName / aliases; those remain the
 * authoritative source of truth on the diagnostic.
 */
export function buildLocationIdentityDiagnostics(
  canonical: CanonicalProjection
): LocationIdentityDiagnostic[] {
  const out: LocationIdentityDiagnostic[] = [];

  for (const loc of canonical.canonicalLocations) {
    const sourceKinds = getLocationSourceKinds(loc);
    const confidence = getLocationConfidence(loc);
    const aliases = [...loc.aliases].sort((a, b) => a.localeCompare(b));
    const aliasCount = aliases.length;
    const isOfficialBacked = !!(sourceKinds.hasNdic || sourceKinds.hasSwd);
    const isCustomOnly = sourceKinds.hasFallbackOnly === true;
    const isMergedAliasSet = aliasCount > 1;

    // Phase 12 — alias conflict count excludes the preferred display name so
    // the signal reflects "other" names grouped under this canonical key.
    const aliasConflictCount = aliases.filter(
      (a) => a !== loc.preferredName
    ).length;

    const hasMixedSourceKinds = countSourceKinds(sourceKinds) > 1;
    const isStableIdentity =
      aliasConflictCount === 0 && !hasMixedSourceKinds;

    const locationTrustLevel = deriveTrustLevel(confidence, aliasConflictCount);

    // Drift — visible only from this dataset (no history). Two passive
    // signals:
    //   (1) more than one distinct display name under the same canonical key
    //   (2) more than one source-kind signal on the merged view
    // Either triggers the flag. Custom/fallback-only by itself does NOT —
    // weak is not wrong.
    const distinctDisplayNames = new Set(
      aliases.map((a) => a.toLowerCase().trim()).filter((a) => a.length > 0)
    );
    const hasMultipleDisplayNames = distinctDisplayNames.size > 1;
    const potentialDrift = hasMultipleDisplayNames || hasMixedSourceKinds;

    const reasons: string[] = [];
    if (isOfficialBacked) reasons.push('official-backed location');
    if (sourceKinds.hasWellConfig)
      reasons.push('configured location without official backing');
    if (isCustomOnly) reasons.push('custom/fallback-only location');
    if (isMergedAliasSet) reasons.push('multiple aliases grouped');
    if (hasMixedSourceKinds) reasons.push('mixed source kinds observed');

    // Phase 13 — convergence review signals. Names are synonyms of the
    // existing Phase 11 flags, kept separate on purpose so consumers that
    // want the convergence-oriented vocabulary don't have to derive them.
    const hasOfficialBacking = isOfficialBacked;
    const isFallbackOnly = isCustomOnly;
    const aliasDiversity = computeAliasDiversity(aliases);

    const { disposition: convergenceDisposition, reasons: convergenceReasons } =
      deriveLocationConvergenceDisposition({
        hasOfficialBacking,
        isFallbackOnly,
        kind: loc.kind,
        locationTrustLevel,
        potentialDrift,
        isStableIdentity,
        aliasConflictCount,
        hasMixedSourceKinds,
      });

    // Phase 14 — preview-only simulation. Attached for candidate/hold;
    // undefined for exclude. Never drives behavior.
    const convergencePreview = deriveLocationConvergencePreview({
      disposition: convergenceDisposition,
      preferredName: loc.preferredName,
      aliases,
      ndicName: loc.ndicName,
      officialName: loc.officialName,
      aliasConflictCount,
      hasMixedSourceKinds,
    });

    // Phase 15 — derived review disposition. Pure recomputation from the
    // Phase 11-14 facts above. Never persisted, never written anywhere.
    const {
      disposition: reviewDisposition,
      reasons: reviewReasons,
      isEligible: isReviewEligible,
    } = deriveLocationReviewDisposition({
      convergenceDisposition,
      locationTrustLevel,
      isStableIdentity,
      aliasConflictCount,
      potentialDrift,
      isFallbackOnly,
      convergencePreview,
    });

    // Phase 16 — derived effective identity for approved diagnostics.
    // Absent for everything else. Read-only hook; never rewrites source
    // truth (canonicalLocationKey, preferredName, aliases all stay as-is).
    const effectiveConvergence = deriveEffectiveLocationConvergence({
      reviewDisposition,
      canonicalLocationKey: loc.canonicalLocationKey,
      preferredName: loc.preferredName,
      convergencePreview,
    });

    const diag: LocationIdentityDiagnostic = {
      canonicalLocationKey: loc.canonicalLocationKey,
      preferredName: loc.preferredName,
      aliases,
      aliasCount,
      confidence,
      sourceKinds,
      reasons,
      isCustomOnly,
      isOfficialBacked,
      isMergedAliasSet,
      isStableIdentity,
      aliasConflictCount,
      hasMixedSourceKinds,
      locationTrustLevel,
      hasOfficialBacking,
      isFallbackOnly,
      aliasDiversity,
      convergenceDisposition,
      convergenceReasons,
      reviewDisposition,
      reviewReasons,
      isReviewEligible,
    };
    if (loc.kind !== undefined) diag.kind = loc.kind;
    if (potentialDrift) diag.potentialDrift = true;
    if (convergencePreview !== undefined) {
      diag.convergencePreview = convergencePreview;
    }
    if (effectiveConvergence !== undefined) {
      diag.effectiveConvergence = effectiveConvergence;
    }
    out.push(diag);
  }

  return out.sort((a, b) =>
    a.canonicalLocationKey.localeCompare(b.canonicalLocationKey)
  );
}
