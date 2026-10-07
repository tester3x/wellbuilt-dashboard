type Row = Record<string, any>;
/** Same company directory semantics as WB-T: exclusions, renames, custom SWDs. */
export function applyDispatchSwdDirectory(disposals: Row[], directory: Row[]): Row[] {
  const blocked = new Set(directory.filter(e => e.isBlacklisted).map(e => String(e.ndicWellName || e.displayName || '').toLowerCase()));
  const aliases = new Map(directory.filter(e => !e.isCustom && !e.isBlacklisted && e.ndicWellName).map(e => [String(e.ndicWellName).toLowerCase(), e]));
  const rows = disposals.filter(d => !blocked.has(String(d.well_name).toLowerCase())).map(d => {
    const alias = aliases.get(String(d.well_name).toLowerCase());
    if (!alias) return d;
    const operator = alias.operator || d.operator;
    return { ...d, well_name: alias.displayName, operator, latitude: alias.latitude ?? d.latitude, longitude: alias.longitude ?? d.longitude, county: alias.county || d.county, api_no: alias.apiNo || d.api_no, search_name: String(alias.displayName).toLowerCase(), search_operator: String(operator || '').toLowerCase() };
  });
  for (const e of directory) {
    if (!e.isCustom || e.isBlacklisted) continue;
    rows.push({ well_name: e.displayName, operator: e.operator || '', api_no: e.apiNo || '', latitude: e.latitude ?? null, longitude: e.longitude ?? null, county: e.county || '', search_name: String(e.displayName).toLowerCase(), search_operator: String(e.operator || '').toLowerCase() });
  }
  return rows;
}
