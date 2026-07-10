/**
 * Server-side equipment types — kept aligned with Dashboard/src/lib/equipment/types.ts
 * Phase 1B canonical model. Do not diverge without updating both locations.
 */

import * as admin from 'firebase-admin';
import { ActorRef } from './actor';

export const EQUIPMENT_STATUSES = [
  'ready',
  'needs_service',
  'scheduled',
  'in_shop',
  'out_of_service',
] as const;

export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export interface EquipmentType {
  typeId: string;
  companyId: string;
  label: string;
  icon?: string;
  specSchema?: string[];
  dvirTemplateId?: string;
  active: boolean;
  sortOrder?: number;
  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

export interface Equipment {
  equipmentId: string;
  companyId: string;
  equipmentTypeId: string;
  unitNumber: string;
  displayName?: string;
  status: EquipmentStatus;
  active: boolean;
  make?: string;
  model?: string;
  year?: string;
  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

export function equipmentCollection(companyId: string): string {
  return `companies/${companyId}/equipment`;
}

export function equipmentTypesCollection(companyId: string): string {
  return `companies/${companyId}/equipment_types`;
}

/** Reserve permanent equipmentId via Firestore auto-ID (call once at create). */
export function reserveEquipmentId(companyId: string): string {
  return admin.firestore().collection(equipmentCollection(companyId)).doc().id;
}