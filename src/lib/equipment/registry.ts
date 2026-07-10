/**
 * WB eQuipment — Equipment registry client (eQuipmentEquipment callable).
 * Dashboard and future mobile admin flows use this layer for registry CRUD.
 */

import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '../firebase';
import type { Equipment, EquipmentCreateInput, EquipmentType, EquipmentUpdateInput } from './types';

type RegistryAction =
  | 'registry.seedTypes'
  | 'registry.defineEquipmentType'
  | 'registry.registerEquipment'
  | 'registry.updateEquipment'
  | 'registry.getEquipment'
  | 'registry.listEquipment'
  | 'registry.resolveByUnit';

async function callRegistry<T = Record<string, unknown>>(
  action: RegistryAction,
  payload: Record<string, unknown>,
): Promise<T> {
  const fn = httpsCallable(getFirebaseFunctions(), 'eQuipmentEquipment');
  const result = await fn({ action, payload });
  return result.data as T;
}

/** Seed platform-default equipment types for a company (idempotent). */
export async function seedEquipmentTypes(companyId: string): Promise<{ seeded: number; skipped: number }> {
  return callRegistry('registry.seedTypes', { companyId });
}

/** Define a company-specific equipment type (e.g. steam_unit, vac_truck). */
export async function defineEquipmentType(
  companyId: string,
  input: { typeId: string; label: string; icon?: string; sortOrder?: number; active?: boolean },
): Promise<EquipmentType> {
  const res = await callRegistry<{ type: EquipmentType }>('registry.defineEquipmentType', {
    companyId,
    ...input,
  });
  return res.type;
}

/** Register new equipment — assigns permanent equipmentId. */
export async function registerEquipment(
  input: EquipmentCreateInput,
): Promise<Equipment> {
  const res = await callRegistry<{ equipment: Equipment }>('registry.registerEquipment', {
    companyId: input.companyId,
    equipmentTypeId: input.equipmentTypeId,
    unitNumber: input.unitNumber,
    displayName: input.displayName,
    status: input.status,
    active: input.active,
    make: input.make,
    model: input.model,
    year: input.year,
  });
  return res.equipment;
}

/** Update equipment display/operational fields (not equipmentId or companyId). */
export async function updateEquipment(
  companyId: string,
  equipmentId: string,
  patch: EquipmentUpdateInput,
): Promise<Equipment> {
  const res = await callRegistry<{ equipment: Equipment }>('registry.updateEquipment', {
    companyId,
    equipmentId,
    ...patch,
  });
  return res.equipment;
}

export async function getEquipment(companyId: string, equipmentId: string): Promise<Equipment> {
  const res = await callRegistry<{ equipment: Equipment }>('registry.getEquipment', {
    companyId,
    equipmentId,
  });
  return res.equipment;
}

export async function listEquipment(
  companyId: string,
  options?: { equipmentTypeId?: string; activeOnly?: boolean },
): Promise<{ equipment: Equipment[]; types: EquipmentType[] }> {
  return callRegistry('registry.listEquipment', {
    companyId,
    equipmentTypeId: options?.equipmentTypeId,
    activeOnly: options?.activeOnly,
  });
}

/**
 * Compatibility bridge — resolve canonical equipment from legacy type + unitNumber.
 * Returns null if no active registry record exists yet (pre-migration).
 */
export async function resolveEquipmentByUnit(
  companyId: string,
  equipmentTypeId: string,
  unitNumber: string,
): Promise<{ equipment: Equipment | null; legacyKey: string }> {
  return callRegistry('registry.resolveByUnit', {
    companyId,
    equipmentTypeId,
    unitNumber,
  });
}