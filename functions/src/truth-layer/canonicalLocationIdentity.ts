import type {
  CanonicalProjection,
  LocationCanonicalView,
} from './types.canonical';
import type { LocationRef } from './types';

export type LocationIdentityConfidence = 'strong' | 'medium' | 'weak';

export interface LocationSourceKinds {
  hasNdic?: boolean;
  hasSwd?: boolean;
  hasWellConfig?: boolean;
  hasFallbackOnly?: boolean;
}

export interface CanonicalLocationIndexEntry {
  preferredName: string;
  aliases: string[];
  confidence: LocationIdentityConfidence;
  kind?: LocationRef['kind'];
  sourceKinds: LocationSourceKinds;
  operator?: string;
  county?: string;
  apiNo?: string;
  ndicName?: string;
  officialName?: string;
  linkedKeys: string[];
}

export type CanonicalLocationIndex = Record<string, CanonicalLocationIndexEntry>;

/**
 * Source-kind classification for a canonical location. Derived ONLY from
 * observed catalog signals; never inferred. Custom/fallback locations are
 * valid operational reality and surface as hasFallbackOnly (not as errors).
 *
 * Detection rules (from resolveLocationRef's catalog fallthrough):
 *   ndicName set                                          → NDIC backing
 *   officialName set AND kind='disposal' AND no ndicName  → SWD backing
 *   officialName set AND kind!='disposal' AND no ndicName → well_config backing
 *   neither set                                           → fallback/custom only
 *
 * In the merged-view case (multiple raw refs collapsed to one canonical),
 * the strongest observed signal wins — mergeLocationRefs keeps the first
 * non-undefined officialName/ndicName, which matches the confidence bump.
 */
export function getLocationSourceKinds(
  view: LocationCanonicalView
): LocationSourceKinds {
  const out: LocationSourceKinds = {};
  const hasNdicName = !!view.ndicName && view.ndicName.trim().length > 0;
  const hasOfficial = !!view.officialName && view.officialName.trim().length > 0;

  if (hasNdicName) out.hasNdic = true;

  if (!hasNdicName && hasOfficial && view.kind === 'disposal') {
    out.hasSwd = true;
  }

  if (!hasNdicName && hasOfficial && view.kind !== 'disposal') {
    out.hasWellConfig = true;
  }

  if (!hasNdicName && !hasOfficial) {
    out.hasFallbackOnly = true;
  }

  return out;
}

/**
 * Location identity confidence — derived from observed source kinds.
 *
 *   strong  — NDIC or SWD observed
 *   medium  — well_config observed (not NDIC/SWD)
 *   weak    — fallback/custom/free-text only
 */
export function getLocationConfidence(
  view: LocationCanonicalView
): LocationIdentityConfidence {
  const src = getLocationSourceKinds(view);
  if (src.hasNdic || src.hasSwd) return 'strong';
  if (src.hasWellConfig) return 'medium';
  return 'weak';
}

/**
 * Build a lookup map from canonicalLocationKey to display/alias/confidence
 * + source signals. Consumers use this to map any raw location reference to
 * the same canonical identity without re-running the canonical projection.
 */
export function buildCanonicalLocationIndex(
  canonical: CanonicalProjection
): CanonicalLocationIndex {
  const out: CanonicalLocationIndex = {};
  for (const loc of canonical.canonicalLocations) {
    const entry: CanonicalLocationIndexEntry = {
      preferredName: loc.preferredName,
      aliases: [...loc.aliases].sort((a, b) => a.localeCompare(b)),
      confidence: getLocationConfidence(loc),
      sourceKinds: getLocationSourceKinds(loc),
      linkedKeys: [...loc.linkedKeys].sort(),
    };
    if (loc.kind !== undefined) entry.kind = loc.kind;
    if (loc.operator !== undefined) entry.operator = loc.operator;
    if (loc.county !== undefined) entry.county = loc.county;
    if (loc.apiNo !== undefined) entry.apiNo = loc.apiNo;
    if (loc.ndicName !== undefined) entry.ndicName = loc.ndicName;
    if (loc.officialName !== undefined) entry.officialName = loc.officialName;
    out[loc.canonicalLocationKey] = entry;
  }
  return out;
}

/**
 * Resolve ANY location reference (canonical key, raw key, or free-text
 * display name) to its canonical-location-index entry. Never invents a
 * match that isn't already represented in the canonical data.
 *
 * Lookup order:
 *   1. Direct canonical-key hit
 *   2. Scan linkedKeys for raw-key hit
 *   3. Scan aliases for display-name hit (case-sensitive — normalization is
 *      the caller's responsibility)
 */
export function lookupCanonicalLocation(
  ref: string,
  index: CanonicalLocationIndex
):
  | {
      canonicalLocationKey: string;
      entry: CanonicalLocationIndexEntry;
    }
  | undefined {
  const direct = index[ref];
  if (direct) {
    return { canonicalLocationKey: ref, entry: direct };
  }
  for (const [canonicalLocationKey, entry] of Object.entries(index)) {
    if (entry.linkedKeys.includes(ref)) {
      return { canonicalLocationKey, entry };
    }
  }
  for (const [canonicalLocationKey, entry] of Object.entries(index)) {
    if (entry.aliases.includes(ref)) {
      return { canonicalLocationKey, entry };
    }
  }
  return undefined;
}
