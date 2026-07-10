/**
 * Compatibility layer — bridge legacy truck/trailer number identity to canonical equipment.
 *
 * During migration (M0–M3):
 * - SecureStore wbew_truckNumber / wbew_trailerNumber remain valid
 * - vehicle_documents still query by equipmentType + equipmentNumber strings
 * - This module produces lookup keys until equipmentId resolution is wired
 *
 * Do NOT use legacy keys as permanent foreign keys in new writes.
 */

import type { SeedEquipmentTypeId } from './seedTypes';

/** Legacy composite key used by equipment_specs and vehicle_documents grouping. */
export function legacyEquipmentKey(equipmentTypeId: string, unitNumber: string): string {
  return `${equipmentTypeId}_${normalizeUnitNumber(unitNumber)}`;
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

export function normalizeUnitNumber(unitNumber: string): string {
  return unitNumber.trim().toUpperCase();
}

/** Mobile SecureStore keys (compatibility bridge — not canonical identity). */
export const LEGACY_MOBILE_STORE_KEYS = {
  truckNumber: 'wbew_truckNumber',
  trailerNumber: 'wbew_trailerNumber',
  truckEquipmentId: 'wbew_truckEquipmentId',
  trailerEquipmentId: 'wbew_trailerEquipmentId',
} as const;

export interface LegacyAssignmentContext {
  truckNumber?: string;
  trailerNumber?: string;
  truckEquipmentId?: string;
  trailerEquipmentId?: string;
}

export interface LegacyAssignmentLookup {
  truck?: { equipmentTypeId: SeedEquipmentTypeId; unitNumber: string; legacyKey: string };
  trailer?: { equipmentTypeId: SeedEquipmentTypeId; unitNumber: string; legacyKey: string };
}

/**
 * Build lookup descriptors from legacy assignment strings.
 * equipmentId fields pass through when already resolved (M1+).
 */
export function resolveLegacyAssignment(ctx: LegacyAssignmentContext): LegacyAssignmentLookup {
  const out: LegacyAssignmentLookup = {};
  if (ctx.truckNumber?.trim()) {
    const unitNumber = normalizeUnitNumber(ctx.truckNumber);
    out.truck = { equipmentTypeId: 'truck', unitNumber, legacyKey: legacyEquipmentKey('truck', unitNumber) };
  }
  if (ctx.trailerNumber?.trim()) {
    const unitNumber = normalizeUnitNumber(ctx.trailerNumber);
    out.trailer = { equipmentTypeId: 'trailer', unitNumber, legacyKey: legacyEquipmentKey('trailer', unitNumber) };
  }
  return out;
}

/**
 * Whether a record has resolved canonical equipment identity.
 */
export function hasCanonicalEquipmentId(equipmentId?: string | null): equipmentId is string {
  return typeof equipmentId === 'string' && equipmentId.length > 0;
}