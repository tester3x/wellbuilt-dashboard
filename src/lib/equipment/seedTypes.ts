import type { ActorRef } from './metadata';
import { PLATFORM_EQUIPMENT_TYPES } from './platformTypes';
import type { EquipmentType } from './types';

/** @deprecated Use PLATFORM_EQUIPMENT_TYPES — kept for compatibility imports. */
export const SEED_EQUIPMENT_TYPE_IDS = ['truck', 'trailer'] as const;
export type SeedEquipmentTypeId = (typeof SEED_EQUIPMENT_TYPE_IDS)[number];

const SYSTEM_ACTOR: ActorRef = { type: 'system', reason: 'seed-equipment-types' };

/** Build platform-default EquipmentType records for a company. */
export function buildPlatformEquipmentTypes(companyId: string): EquipmentType[] {
  const now = new Date().toISOString();
  return PLATFORM_EQUIPMENT_TYPES.map((def) => ({
    typeId: def.typeId,
    companyId,
    label: def.label,
    active: true,
    sortOrder: def.sortOrder,
    source: 'platform' as const,
    createdAt: now,
    createdBy: SYSTEM_ACTOR,
    updatedAt: now,
    updatedBy: SYSTEM_ACTOR,
  }));
}

/** @deprecated Use buildPlatformEquipmentTypes */
export function buildSeedEquipmentTypes(companyId: string): EquipmentType[] {
  return buildPlatformEquipmentTypes(companyId).filter(
    (t) => t.typeId === 'truck' || t.typeId === 'trailer',
  );
}