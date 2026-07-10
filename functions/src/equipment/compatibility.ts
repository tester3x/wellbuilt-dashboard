/**
 * Legacy identity bridge — aligned with Dashboard/src/lib/equipment/compatibility.ts
 */

export function legacyEquipmentKey(equipmentTypeId: string, unitNumber: string): string {
  return `${equipmentTypeId}_${unitNumber.trim().toUpperCase()}`;
}

export function parseLegacyEquipmentKey(key: string): {
  equipmentTypeId: string;
  unitNumber: string;
} | null {
  const idx = key.indexOf('_');
  if (idx <= 0) return null;
  return {
    equipmentTypeId: key.slice(0, idx),
    unitNumber: key.slice(idx + 1),
  };
}

export const LEGACY_MOBILE_STORE_KEYS = {
  truckNumber: 'wbew_truckNumber',
  trailerNumber: 'wbew_trailerNumber',
  truckEquipmentId: 'wbew_truckEquipmentId',
  trailerEquipmentId: 'wbew_trailerEquipmentId',
} as const;