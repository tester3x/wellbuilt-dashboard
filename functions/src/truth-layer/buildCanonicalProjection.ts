import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import { resolveCanonicalOperatorKey } from './resolveCanonicalOperatorKey';
import { resolveCanonicalLocationKey } from './resolveCanonicalLocationKey';
import { resolveCanonicalActivity } from './resolveCanonicalActivity';

export function buildCanonicalProjection(
  projection: TruthProjection
): CanonicalProjection {
  return {
    canonicalOperators: resolveCanonicalOperatorKey(projection.operators),
    canonicalLocations: resolveCanonicalLocationKey(projection.locations),
    canonicalActivities: resolveCanonicalActivity(projection.activities),
  };
}
