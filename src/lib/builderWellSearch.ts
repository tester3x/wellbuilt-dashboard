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
  customLocations?: Array<{ locationName: string; company: string; usageCount?: number }>;
}

export const COMBINED_SEARCH_LIMIT = 15;

export function wellsForBuilderOperator<T extends { wellName: string; ndicName?: string }>(
  wells: T[],
  operatorWells: CombinedSearchSources['operatorWells'],
  selectedOperator: string,
): T[] {
  if (!selectedOperator) return wells;
  return wells.filter(w => operatorForBuilderWell(w.wellName, operatorWells, w.ndicName).toLowerCase() === selectedOperator.toLowerCase());
}

/** The operator carried by a dispatch must match the selected well exactly. */
export function operatorForBuilderWell(
  wellName: string,
  operatorWells: CombinedSearchSources['operatorWells'],
  ndicName?: string,
): string {
  const names = [wellName, ndicName].map(name => (name || '').trim().toLowerCase()).filter(Boolean);
  if (!names.length) return '';
  return operatorWells.find(w => names.includes(w.well_name.trim().toLowerCase()) && w.operator?.trim())?.operator?.trim() || '';
}

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
    .filter((w) => locationQueryMatches(q, w.ndicName || w.wellName))
    .map((w) => {
      const name = w.ndicName || w.wellName;
      seen.add(name.toLowerCase());
      const operator = operatorForBuilderWell(w.wellName, s.operatorWells, w.ndicName);
      const catalog = s.operatorWells.find(o => o.well_name.toLowerCase() === name.toLowerCase());
      return { label: name, sub: operator || w.route || '', county: catalog?.county, kind: 'WELL', value: name };
    });
  const operatorMatches: CombinedLocation[] = s.operatorWells
    .filter((w) => locationQueryMatches(q, w.well_name) && !seen.has(w.well_name.toLowerCase()))
    .map((w) => {
      seen.add(w.well_name.toLowerCase());
      return { label: w.well_name, sub: w.operator || 'NDIC', county: w.county, kind: 'WELL', value: w.well_name };
    });
  const disposalMatches: CombinedLocation[] = s.disposalMatches
    .filter((d) => !seen.has(d.well_name.toLowerCase()))
    .map((d): CombinedLocation => ({ label: d.well_name, sub: d.operator || 'SWD', county: d.county, kind: 'SWD', value: d.well_name }));
  const customMatches: CombinedLocation[] = (s.customLocations || [])
    .filter(c => locationQueryMatches(q, c.locationName) && !seen.has(c.locationName.toLowerCase()))
    .map(c => ({ label: c.locationName, sub: `Used ${c.usageCount || 0}× — ${c.company || 'Custom'}`, kind: 'LOC', value: c.locationName }));
  return rankLocationRows([...wellMatches, ...operatorMatches, ...disposalMatches, ...customMatches], q, row => row.label, COMBINED_SEARCH_LIMIT);
}

/** Match and ranking parity with WB-T: ignore location noise words; cap after ranking. */
export function locationQueryMatches(query: string, text: string): boolean {
  const noise = new Set(['pad', 'well', 'site', 'loc', 'location', 'the', 'at', 'on', 'in']);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const target = text.toLowerCase();
  let matchedAny = false;
  for (const word of words) {
    if (target.includes(word)) matchedAny = true;
    else if (!noise.has(word)) return false;
  }
  return matchedAny;
}
export function rankLocationRows<T>(rows: T[], query: string, getName: (row: T) => string, limit: number): T[] {
  const q = query.trim().toLowerCase();
  const rank = (name: string) => name === q ? 0 : name.startsWith(q) ? 1 : 2;
  return [...rows].sort((a, b) => {
    const an = getName(a).toLowerCase(), bn = getName(b).toLowerCase();
    return rank(an) - rank(bn) || an.localeCompare(bn, undefined, { numeric: true });
  }).slice(0, limit);
}
