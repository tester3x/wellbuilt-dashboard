/**
 * Shared "combined" location search for the Service Work Builder fields (Well /
 * Location and Drop-off): merges the governed well pool, the full company operator
 * well universe, and the SWD/disposal directory into one de-duplicated, bounded
 * result list. Pure and node-testable. Preserves the existing WELL/SWD/operator
 * search universe and ordering (wells → operator wells → disposals).
 */

export interface CombinedLocation {
  label: string;
  sub: string;
  value: string;
  kind?: 'WELL' | 'SWD' | 'LOC';
  county?: string;
}

export interface CombinedSearchSources {
  /** Governed well pool rows (need ndicName/wellName + route). */
  wells: Array<{ ndicName?: string; wellName: string; route?: string }>;
  /** Full company operator well universe (well_name + operator). */
  operatorWells: Array<{ well_name: string; operator?: string; county?: string }>;
  /** SWD/disposal directory search result rows (well_name). */
  disposalMatches: Array<{ well_name: string; operator?: string; county?: string }>;
  customLocations?: Array<{ locationName: string; company: string }>;
}

export const COMBINED_SEARCH_LIMIT = 15;

/** True when the query exactly matches an existing location (so no list is shown). */
export function hasExactLocationMatch(query: string, s: CombinedSearchSources): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    s.wells.some((w) => (w.ndicName || w.wellName).toLowerCase() === q) ||
    s.operatorWells.some((w) => w.well_name.toLowerCase() === q) ||
    s.disposalMatches.some((d) => d.well_name.toLowerCase() === q) ||
    (s.customLocations || []).some(c => c.locationName.toLowerCase() === q)
  );
}

/**
 * Build the combined, de-duplicated, bounded result list for a query. Returns [] for
 * queries under two characters or when the query already exactly matches a location.
 */
export function combinedLocationResults(query: string, s: CombinedSearchSources): CombinedLocation[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  if (hasExactLocationMatch(query, s)) return [];
  const seen = new Set<string>();
  const wellMatches: CombinedLocation[] = s.wells
    .filter((w) => (w.ndicName || w.wellName).toLowerCase().includes(q))
    .map((w) => {
      const name = w.ndicName || w.wellName;
      seen.add(name.toLowerCase());
      const catalog = s.operatorWells.find(o => o.well_name.toLowerCase() === name.toLowerCase());
      return { label: name, sub: catalog?.operator || w.route || '', county: catalog?.county, kind: 'WELL', value: name };
    });
  const operatorMatches: CombinedLocation[] = s.operatorWells
    .filter((w) => w.well_name.toLowerCase().includes(q) && !seen.has(w.well_name.toLowerCase()))
    .map((w) => {
      seen.add(w.well_name.toLowerCase());
      return { label: w.well_name, sub: w.operator || 'NDIC', county: w.county, kind: 'WELL', value: w.well_name };
    });
  const disposalMatches: CombinedLocation[] = s.disposalMatches
    .filter((d) => !seen.has(d.well_name.toLowerCase()))
    .map((d): CombinedLocation => ({ label: d.well_name, sub: d.operator || 'SWD', county: d.county, kind: 'SWD', value: d.well_name }));
  const customMatches: CombinedLocation[] = (s.customLocations || [])
    .filter(c => c.locationName.toLowerCase().includes(q) && !seen.has(c.locationName.toLowerCase()))
    .map(c => ({ label: c.locationName, sub: c.company, kind: 'LOC', value: c.locationName }));
  return [...wellMatches, ...operatorMatches, ...disposalMatches, ...customMatches].slice(0, COMBINED_SEARCH_LIMIT);
}
