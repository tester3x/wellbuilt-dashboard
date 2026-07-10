import type { ActorRef } from './metadata';
import type { EquipmentType } from './types';

/** Phase 1B seed types — truck and trailer only. Schema supports more later. */
export const SEED_EQUIPMENT_TYPE_IDS = ['truck', 'trailer'] as const;

export type SeedEquipmentTypeId = (typeof SEED_EQUIPMENT_TYPE_IDS)[number];

export const SEED_EQUIPMENT_TYPE_LABELS: Record<SeedEquipmentTypeId, string> = {
  truck: 'Truck',
  trailer: 'Trailer',
};

const SYSTEM_ACTOR: ActorRef = { type: 'system', reason: 'seed-equipment-types' };

/** Build seed EquipmentType records for a company (idempotent by typeId). */
export function buildSeedEquipmentTypes(companyId: string): EquipmentType[] {
  const now = new Date().toISOString();
  return SEED_EQUIPMENT_TYPE_IDS.map((typeId, index) => ({
    typeId,
    companyId,
    label: SEED_EQUIPMENT_TYPE_LABELS[typeId],
    active: true,
    sortOrder: index,
    createdAt: now,
    createdBy: SYSTEM_ACTOR,
    updatedAt: now,
    updatedBy: SYSTEM_ACTOR,
  }));
}