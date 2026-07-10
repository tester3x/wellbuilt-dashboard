/**
 * Canonical Firestore and Storage path builders for WB eQuipment.
 */

/** companies/{companyId}/equipment/{equipmentId} */
export function equipmentCollectionPath(companyId: string): string {
  return `companies/${companyId}/equipment`;
}

export function equipmentDocPath(companyId: string, equipmentId: string): string {
  return `${equipmentCollectionPath(companyId)}/${equipmentId}`;
}

/** Future: type-specific specs child document (weight, capacity, VIN, axles, etc.). */
export function equipmentSpecificationsDocPath(companyId: string, equipmentId: string): string {
  return `${equipmentDocPath(companyId, equipmentId)}/specifications/current`;
}

/** companies/{companyId}/equipment_types/{typeId} */
export function equipmentTypesCollectionPath(companyId: string): string {
  return `companies/${companyId}/equipment_types`;
}

export function equipmentTypeDocPath(companyId: string, typeId: string): string {
  return `${equipmentTypesCollectionPath(companyId)}/${typeId}`;
}

/**
 * Future: equipment-owned documents (replaces transitional vehicle_documents).
 * equipment_documents/{docId} with equipmentId field, or subcollection under equipment.
 */
export function equipmentDocumentsCollectionPath(): string {
  return 'equipment_documents';
}

/**
 * Storage path for equipment document images (future — keyed by equipmentId).
 */
export function equipmentDocumentStoragePath(
  companyId: string,
  equipmentId: string,
  docId: string,
  ext = 'jpg',
): string {
  return `equip_docs/equipment/${companyId}/${equipmentId}/${docId}.${ext}`;
}

/** Legacy transitional collection — read during migration only. */
export const LEGACY_VEHICLE_DOCUMENTS_COLLECTION = 'vehicle_documents';

/** Legacy specs subcollection — read during migration only. */
export function legacyEquipmentSpecsCollectionPath(companyId: string): string {
  return `companies/${companyId}/equipment_specs`;
}

// ── Assignments (custody) ───────────────────────────────────────────────────
// Answers: who currently has custody of this equipment?

/** companies/{companyId}/assignments/{assignmentId} */
export function assignmentsCollectionPath(companyId: string): string {
  return `companies/${companyId}/assignments`;
}

export function assignmentDocPath(companyId: string, assignmentId: string): string {
  return `${assignmentsCollectionPath(companyId)}/${assignmentId}`;
}