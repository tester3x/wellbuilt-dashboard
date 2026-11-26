export const INDEPENDENT_SECTORS = ['water-hauling', 'ltl', 'otr', 'hot-shot', 'aggregate'] as const;
export type IndependentSector = typeof INDEPENDENT_SECTORS[number];

export const SECTOR_FIELDS: Record<IndependentSector, readonly string[]> = {
  'water-hauling': ['waterType', 'volumeBbl', 'sourceReference', 'disposalReference'],
  ltl: ['freightDescription', 'pieces', 'pallets', 'weightLbs', 'freightClass'],
  otr: ['trailerType', 'commodity', 'weightLbs', 'pickupAppointment', 'deliveryAppointment'],
  'hot-shot': ['urgency', 'cargoDetails', 'vehicleRequirement', 'readyBy'],
  aggregate: ['material', 'estimatedTons', 'loadCount', 'scaleTicket'],
};
export const REQUIRED_SECTOR_FIELDS: Record<IndependentSector, readonly string[]> = {
  'water-hauling': ['waterType', 'volumeBbl'],
  ltl: ['freightDescription', 'pieces'],
  otr: ['trailerType', 'commodity'],
  'hot-shot': ['urgency', 'cargoDetails'],
  aggregate: ['material', 'estimatedTons'],
};
export function isIndependentSector(value: unknown): value is IndependentSector {
  return typeof value === 'string' && (INDEPENDENT_SECTORS as readonly string[]).includes(value);
}
export function parseIndependentSectors(value: unknown): IndependentSector[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > INDEPENDENT_SECTORS.length
    || value.some(item => !isIndependentSector(item)) || new Set(value).size !== value.length)
    throw Error('invalid_sectors');
  return value as IndependentSector[];
}
export function parseSectorFields(sector: IndependentSector, value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_sector_fields');
  const raw = value as Record<string, unknown>;
  const allowed = SECTOR_FIELDS[sector];
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw Error('unexpected_sector_field');
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const field = raw[key] ?? '';
    if (typeof field !== 'string' || field.length > 160) throw Error(`invalid_${key}`);
    result[key] = field.trim();
  }
  for (const key of REQUIRED_SECTOR_FIELDS[sector]) if (!result[key]) throw Error(`required_${key}`);
  for (const key of ['volumeBbl', 'pieces', 'pallets', 'weightLbs', 'estimatedTons', 'loadCount']) {
    if (result[key] && (!/^\d+(?:\.\d{1,2})?$/.test(result[key]) || Number(result[key]) <= 0))
      throw Error(`invalid_${key}`);
  }
  return result;
}
