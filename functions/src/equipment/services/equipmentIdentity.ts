import * as admin from 'firebase-admin';
import { legacyEquipmentKey } from '../compatibility';
import { Equipment, EquipmentType, equipmentCollection, equipmentTypesCollection } from '../types/equipment';

const firestore = admin.firestore();

export interface EquipmentIdentitySlice {
  equipmentId: string;
  companyId: string;
  companyName?: string;
  equipmentTypeId: string;
  equipmentTypeLabel?: string;
  unitNumber: string;
  displayName?: string;
  make?: string;
  model?: string;
  year?: string;
  vin?: string;
  licensePlate?: string;
}

function optionalString(val: unknown): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  return String(val);
}

/** Build identity slice from canonical equipment — partial fields omitted when absent. */
export async function buildEquipmentIdentitySlice(
  companyId: string,
  equipment: Equipment,
): Promise<EquipmentIdentitySlice> {
  const typeLabel = await resolveEquipmentTypeLabel(companyId, equipment.equipmentTypeId);
  const companyName = await resolveCompanyName(companyId);
  const legacySpecs = await loadLegacySpecsHints(companyId, equipment);

  const slice: EquipmentIdentitySlice = {
    equipmentId: equipment.equipmentId,
    companyId: equipment.companyId,
    equipmentTypeId: equipment.equipmentTypeId,
    unitNumber: equipment.unitNumber,
  };

  if (companyName) slice.companyName = companyName;
  if (typeLabel) slice.equipmentTypeLabel = typeLabel;
  if (equipment.displayName) slice.displayName = equipment.displayName;

  const make = equipment.make || legacySpecs.make;
  const model = equipment.model || legacySpecs.model;
  const year = equipment.year || legacySpecs.year;
  if (make) slice.make = make;
  if (model) slice.model = model;
  if (year) slice.year = year;

  const vin = optionalString(equipment.vin) || legacySpecs.vin;
  const licensePlate = optionalString(equipment.licensePlate) || legacySpecs.licensePlate;
  if (vin) slice.vin = vin;
  if (licensePlate) slice.licensePlate = licensePlate;

  return slice;
}

export async function loadEquipmentForIdentity(
  companyId: string,
  equipmentId: string,
): Promise<Equipment | null> {
  const snap = await firestore.collection(equipmentCollection(companyId)).doc(equipmentId).get();
  if (!snap.exists) return null;
  const equipment = snap.data() as Equipment;
  if (equipment.companyId !== companyId) return null;
  return equipment;
}

async function resolveEquipmentTypeLabel(companyId: string, typeId: string): Promise<string | undefined> {
  const snap = await firestore.collection(equipmentTypesCollection(companyId)).doc(typeId).get();
  if (!snap.exists) return typeId;
  const type = snap.data() as EquipmentType;
  return type.label || typeId;
}

async function resolveCompanyName(companyId: string): Promise<string | undefined> {
  try {
    const snap = await firestore.collection('companies').doc(companyId).get();
    if (!snap.exists) return undefined;
    const name = snap.data()?.name || snap.data()?.companyName;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function loadLegacySpecsHints(
  companyId: string,
  equipment: Equipment,
): Promise<{ make?: string; model?: string; year?: string; vin?: string; licensePlate?: string }> {
  const key = legacyEquipmentKey(equipment.equipmentTypeId, equipment.unitNumber);
  const snap = await firestore.doc(`companies/${companyId}/equipment_specs/${key}`).get();
  if (!snap.exists) return {};
  const data = snap.data() as Record<string, unknown>;
  return {
    make: optionalString(data.make),
    model: optionalString(data.model),
    year: optionalString(data.year),
    vin: optionalString(data.vin),
    licensePlate: optionalString(data.licensePlate) || optionalString(data.license_plate),
  };
}