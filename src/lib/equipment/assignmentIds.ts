/**
 * assignmentId generation strategy for WB eQuipment Assignments.
 *
 * Rule: assignmentId is assigned once at create time and never changes.
 * It is NOT derived from equipmentId, driverId, or legacy truck/trailer numbers.
 */

import { doc, collection } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

/**
 * Reserve a new assignmentId using Firestore auto-ID before first write.
 * Call this once per create — the returned ID becomes the permanent identity.
 */
export function reserveAssignmentId(db: Firestore, companyId: string): string {
  const ref = doc(collection(db, 'companies', companyId, 'assignments'));
  return ref.id;
}

export function describeAssignmentIdStrategy(): string {
  return [
    'assignmentId = Firestore auto-generated document ID at create time',
    'Stored as both the document ID and the assignmentId field for query convenience',
    'Never computed from equipmentId, driverId, or legacy unit numbers',
    'Ending custody sets active=false and endedAt — assignmentId unchanged',
  ].join('; ');
}