import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import type {
  CompressionGroup,
  RawVsCanonicalComparison,
} from './types.dashboard';
import type { ValidationWarning } from './validateProjection';
import { validateProjection } from './validateProjection';

export interface CompareRawVsCanonicalOptions {
  warnings?: ValidationWarning[];
}

function operatorLabel(
  op: CanonicalProjection['canonicalOperators'][number]
): string {
  return op.displayName ?? op.legalName ?? op.canonicalOperatorKey;
}

export function compareRawVsCanonical(
  projection: TruthProjection,
  canonical: CanonicalProjection,
  options: CompareRawVsCanonicalOptions = {}
): RawVsCanonicalComparison {
  const warnings = options.warnings ?? validateProjection(projection);

  const operatorGroups: CompressionGroup[] = canonical.canonicalOperators
    .map((op) => ({
      canonicalKey: op.canonicalOperatorKey,
      canonicalLabel: operatorLabel(op),
      rawKeys: [...op.linkedKeys].sort(),
      mergedFrom: [...op.mergedFrom].sort(),
      confidence: op.confidence,
    }))
    .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));

  const locationGroups: CompressionGroup[] = canonical.canonicalLocations
    .map((loc) => ({
      canonicalKey: loc.canonicalLocationKey,
      canonicalLabel: loc.preferredName,
      rawKeys: [...loc.linkedKeys].sort(),
      mergedFrom: [...loc.mergedFrom].sort(),
      confidence: loc.confidence,
    }))
    .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));

  const activityGroups: CompressionGroup[] = canonical.canonicalActivities
    .map((act) => ({
      canonicalKey: act.canonicalActivityKey,
      canonicalLabel: act.canonicalLabel,
      rawKeys: [...act.linkedKeys].sort(),
      mergedFrom: [...act.mergedFrom].sort(),
      confidence: act.confidence,
    }))
    .sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));

  return {
    operatorCompression: {
      rawCount: projection.operators.length,
      canonicalCount: canonical.canonicalOperators.length,
      groups: operatorGroups,
    },
    locationCompression: {
      rawCount: projection.locations.length,
      canonicalCount: canonical.canonicalLocations.length,
      groups: locationGroups,
    },
    activityCompression: {
      rawCount: projection.activities.length,
      canonicalCount: canonical.canonicalActivities.length,
      groups: activityGroups,
    },
    unresolvedWarnings: warnings,
  };
}
