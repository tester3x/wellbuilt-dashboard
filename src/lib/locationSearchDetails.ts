/** Source-backed context for every location kind; never invent an address. */
export interface LocationSearchContext {
  operator?: string; company?: string; county?: string; state?: string;
  legal_desc?: string; address?: string; city?: string;
  latitude?: number; longitude?: number;
}
export function locationSearchDetails(row: LocationSearchContext): string {
  const parts = [row.operator || row.company, row.county ? `${row.county} Co.` : '', row.state, row.address, row.city, row.legal_desc];
  if (!row.address && !row.legal_desc && Number.isFinite(row.latitude) && Number.isFinite(row.longitude)
    && Math.abs(row.latitude!) <= 90 && Math.abs(row.longitude!) <= 180 && (row.latitude !== 0 || row.longitude !== 0)) {
    parts.push(`${row.latitude!.toFixed(5)}, ${row.longitude!.toFixed(5)}`);
  }
  return [...new Set(parts.map(p => p?.trim()).filter(Boolean))].join(' · ');
}
