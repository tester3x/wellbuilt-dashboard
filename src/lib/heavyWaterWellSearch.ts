import { locationQueryMatches, operatorForBuilderWell, type CombinedLocation, type CombinedSearchSources } from './builderWellSearch';

export interface WeightedWellCandidate {
  wellName: string;
  ndicName?: string;
  route?: string;
  operator?: string;
  waterWeight?: number;
  tankHeight?: number;
  estimatedFeet: number | null;
  estimatedLevel: string;
}

/** 10 lb/gal and above is one group; below that, use tenths (9.9, 9.8…). */
function weightGroup(weight: number | undefined): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return -1;
  if (weight >= 10) return 100;
  return Math.floor(weight * 10 + 1e-8);
}

/** SW pickup suggestions when Heavy Water is selected. The governed well pool
 * supplies measurements; unknown weights remain available at the bottom. */
export function heavyWaterWellResults(
  query: string,
  wells: readonly WeightedWellCandidate[],
  operatorWells: CombinedSearchSources['operatorWells'],
): CombinedLocation[] {
  const q = query.trim().toLowerCase();
  if (q && wells.some(w => (w.ndicName || w.wellName).toLowerCase() === q)) return [];
  return wells
    .filter(w => !q || locationQueryMatches(q, w.ndicName || w.wellName) || locationQueryMatches(q, w.wellName))
    .sort((a, b) => {
      const groupDiff = weightGroup(b.waterWeight) - weightGroup(a.waterWeight);
      if (groupDiff) return groupDiff;
      const aLevel = a.estimatedFeet ?? Number.NEGATIVE_INFINITY;
      const bLevel = b.estimatedFeet ?? Number.NEGATIVE_INFINITY;
      if (aLevel !== bLevel) return bLevel - aLevel;
      return (a.ndicName || a.wellName).localeCompare(b.ndicName || b.wellName, undefined, { numeric: true });
    })
    .map(w => ({
      label: w.ndicName || w.wellName,
      value: w.ndicName || w.wellName,
      kind: 'WELL' as const,
      sub: operatorForBuilderWell(w.wellName, operatorWells, w.ndicName) || w.operator || w.route || '',
      waterWeight: w.waterWeight,
      tankHeight: w.tankHeight,
      estimatedLevel: w.estimatedLevel,
      showWaterDetails: true,
    }));
}
