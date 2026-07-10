/**
 * DVIR types — Pre-Trip Inspection vertical slice 1.
 * Kept aligned with Dashboard/src/lib/equipment/dvirContracts.ts
 */

import * as admin from 'firebase-admin';
import { ActorRef } from './actor';

export const PRE_TRIP_CATEGORY_IDS = [
  'lights',
  'brakes',
  'tires',
  'emergency_equipment',
  'fluid_leaks',
  'tank',
  'hoses',
  'pto',
  'miscellaneous',
] as const;

export type PreTripCategoryId = (typeof PRE_TRIP_CATEGORY_IDS)[number];

export type InspectionItemResult = 'pass' | 'needs_attention';

export type InspectionOverallResult = InspectionItemResult;

export interface InspectionCategoryRecord {
  categoryId: PreTripCategoryId;
  categoryLabel: string;
  result: InspectionItemResult;
  /** Reserved — defect promotion, photos, comments, severity */
  defectId?: string | null;
  photoEvidenceIds?: string[];
  comments?: string;
  severity?: string;
}

export interface PreTripInspectionRecord {
  inspectionId: string;
  companyId: string;
  equipmentId: string;
  assignmentId: string | null;
  assignmentSource: 'canonical' | 'legacy';
  driverHash: string;
  driverDisplayName?: string;
  equipmentLabel?: string;
  assignmentRole?: string;
  inspectionType: 'pre_trip';
  status: 'submitted';
  overallResult: InspectionOverallResult;
  categories: InspectionCategoryRecord[];
  driverSignature: string;
  startedAt: string;
  submittedAt: string;
  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
  /** Reserved — mechanic review, defect routing */
  reviewedAt?: string;
  reviewedBy?: ActorRef;
  defectIds?: string[];
}

export function dvirInspectionsCollection(companyId: string): string {
  return `companies/${companyId}/dvir_inspections`;
}

export function reserveInspectionId(companyId: string): string {
  return admin.firestore().collection(dvirInspectionsCollection(companyId)).doc().id;
}

export const PRE_TRIP_CATEGORY_LABELS: Record<PreTripCategoryId, string> = {
  lights: 'Lights',
  brakes: 'Brakes',
  tires: 'Tires',
  emergency_equipment: 'Emergency Equipment',
  fluid_leaks: 'Fluid Leaks',
  tank: 'Tank',
  hoses: 'Hoses',
  pto: 'PTO',
  miscellaneous: 'Miscellaneous',
};