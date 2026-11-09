/** Temperature is billing metadata; the Fresh Water job/payroll category never changes. */
export const FRESH_WATER_ACCOUNTS = [
  { value: 'customer', label: 'Customer account' },
  { value: 'company', label: 'Hauler account' },
] as const;

export type FreshWaterAccount = (typeof FRESH_WATER_ACCOUNTS)[number]['value'];

export function freshWaterAccount(value: unknown): FreshWaterAccount | undefined {
  return value === 'customer' || value === 'company' ? value : undefined;
}

export type WaterTemperature = 'hot' | 'cold';
export function isFreshWaterJob(type: unknown): boolean {
  return typeof type === 'string' && /^(fresh[\s_-]*water(?:[\s_-]*tank[\s_-]*refill)?|fw)$/i.test(type.trim());
}
export function waterTemperature(value: unknown): WaterTemperature | undefined {
  return value === 'hot' || value === 'cold' ? value : undefined;
}
export function freshWaterFields(type: unknown, value: unknown): { waterTemperature?: WaterTemperature } {
  const temp = waterTemperature(value);
  return isFreshWaterJob(type) && temp ? { waterTemperature: temp } : {};
}
export function freshWaterLabel(type: string, value: unknown): string {
  const temp = isFreshWaterJob(type) ? waterTemperature(value) : undefined;
  return temp ? `${type} · ${temp === 'hot' ? 'Hot' : 'Cold'}` : type;
}

/** Show the uncommon Hot control only after an explicit FWD pickup selection.
 * Typed names and SWD/drop-off choices do not establish that source identity. */
export function canChooseHotWater(type: unknown, pickupName: string, selected: { name?: unknown; kind?: unknown } | null | undefined): boolean {
  return isFreshWaterJob(type) && !!pickupName.trim() && selected?.name === pickupName
    && typeof selected.kind === 'string' && selected.kind.toLowerCase() === 'fwd';
}

/** Common local spellings of Western Area Water Supply, for depot search only. */
export function freshWaterDepotSearchQuery(query: string): string {
  return query.toLowerCase().replace(/\b(?:wasa|wassa|wawsa)\b/g, 'waws');
}
