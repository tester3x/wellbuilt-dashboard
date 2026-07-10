/**
 * Server-side equipment types — kept aligned with Dashboard/src/lib/equipment/types.ts
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

export const EQUIPMENT_OPERATIONAL_STATUSES = [
  'active',
  'shop',
  'out_of_service',
  'retired',
  'loaned',
  'unknown',
] as const;

export type EquipmentOperationalStatus = (typeof EQUIPMENT_OPERATIONAL_STATUSES)[number];

export interface EquipmentType {
  typeId: string;
  companyId: string;
  label: string;
  icon?: string;
  specSchema?: string[];
  dvirTemplateId?: string;
  active: boolean;
  sortOrder?: number;
  source?: 'platform' | 'company';
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
  equipmentStatus?: EquipmentOperationalStatus | null;
  healthScore?: number | null;
  vin?: string;
  licensePlate?: string;
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

export function reserveEquipmentId(companyId: string): string {
  return admin.firestore().collection(equipmentCollection(companyId)).doc().id;
}