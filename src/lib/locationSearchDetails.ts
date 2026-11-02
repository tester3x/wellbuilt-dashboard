/** Source-backed context for every location kind; never invent an address. */
export interface LocationSearchContext {
  operator?: string; company?: string; county?: string; state?: string;
  legal_desc?: string; address?: string; city?: string;
  latitude?: number; longitude?: number;
}
type PlacePoint = [string, string, number, number];
const places: PlacePoint[] = require('./data/census-place-points-2026.json').places;
const references = new Map<string, string>();
const radians = (degrees: number) => degrees * Math.PI / 180;
function validCoordinates(row: LocationSearchContext): boolean {
  return Number.isFinite(row.latitude) && Number.isFinite(row.longitude)
    && Math.abs(row.latitude!) <= 90 && Math.abs(row.longitude!) <= 180
    && (row.latitude !== 0 || row.longitude !== 0);
}
/** Approximate straight-line place reference. Never changes the selected GPS. */
export function nearbyPlaceReference(row: LocationSearchContext): string {
  const state = row.state?.trim().toUpperCase();
  if (!validCoordinates(row) || state && !['ND', 'MT'].includes(state)) return '';
  const lat = row.latitude!, lng = row.longitude!;
  if (lat < 44 || lat > 50 || lng < -117 || lng > -96) return '';
  const key = `${lat},${lng}`;
  const cached = references.get(key);
  if (cached !== undefined) return cached;
  let nearest: PlacePoint | undefined, distance = Infinity;
  for (const place of places) {
    const a = Math.sin(radians(place[2] - lat) / 2) ** 2
      + Math.cos(radians(lat)) * Math.cos(radians(place[2])) * Math.sin(radians(place[3] - lng) / 2) ** 2;
    const miles = 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (miles < distance) { nearest = place; distance = miles; }
  }
  let result = '';
  if (nearest && distance <= 75) {
    const [placeState, name, placeLat, placeLng] = nearest;
    const bearing = (Math.atan2(Math.sin(radians(lng - placeLng)) * Math.cos(radians(lat)),
      Math.cos(radians(placeLat)) * Math.sin(radians(lat)) - Math.sin(radians(placeLat)) * Math.cos(radians(lat)) * Math.cos(radians(lng - placeLng))) * 180 / Math.PI + 360) % 360;
    const direction = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8];
    result = distance < 1 ? `Near ${name}, ${placeState}` : `~${Math.round(distance)} mi ${direction} of ${name}, ${placeState} (straight-line)`;
  }
  if (references.size >= 5000) references.delete(references.keys().next().value!);
  references.set(key, result);
  return result;
}
/** ND DWR compact TTT/RRR/SS/tract codes; retain already-readable well surveys. */
export function readableSurveyLocation(value: string | undefined, state?: string): string {
  const raw = value?.trim() || '';
  const match = state?.toUpperCase() === 'ND' ? /^(\d{3})(\d{3})(\d{2})([A-D]{0,4})$/i.exec(raw) : null;
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 36) return raw;
  return `Sec ${Number(match[3])} T${Number(match[1])}N R${Number(match[2])}W${match[4] ? ` · Tract ${match[4].toUpperCase()}` : ''}`;
}
export function locationSearchDetails(row: LocationSearchContext): string {
  const nearby = !row.address && !row.city ? nearbyPlaceReference(row) : '';
  const parts = [row.operator || row.company, nearby || row.address, row.city,
    row.county ? `${row.county} Co.` : '', nearby ? '' : row.state,
    nearby ? '' : readableSurveyLocation(row.legal_desc, row.state)];
  if (!nearby && !row.address && !row.legal_desc && validCoordinates(row)) {
    parts.push(`${row.latitude!.toFixed(5)}, ${row.longitude!.toFixed(5)}`);
  }
  return [...new Set(parts.map(p => p?.trim()).filter(Boolean))].join(' · ');
}
