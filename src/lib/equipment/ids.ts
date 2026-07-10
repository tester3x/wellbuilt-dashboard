/**
 * equipmentId generation strategy for WB eQuipment.
 *
 * Rule: equipmentId is assigned once at create time and never changes.
 * It is NOT derived from unitNumber, equipmentTypeId, or legacy keys.
 */

import { doc, collection } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

/**
 * Reserve a new equipmentId using Firestore auto-ID before first write.
 * Call this once per create — the returned ID becomes the permanent identity.
 */
export function reserveEquipmentId(db: Firestore, companyId: string): string {
  const ref = doc(collection(db, 'companies', companyId, 'equipment'));
  return ref.id;
}

/**
 * Server-side equivalent: Admin SDK generates ID the same way.
 * functions equipment service will use admin.firestore().collection(...).doc().id
 */
export function describeEquipmentIdStrategy(): string {
  return [
    'equipmentId = Firestore auto-generated document ID at create time',
    'Stored as both the document ID and the equipmentId field for query convenience',
    'Never computed from unitNumber or legacy type_number keys',
    'Renumbering a unit updates unitNumber only — equipmentId unchanged',
  ].join('; ');
}