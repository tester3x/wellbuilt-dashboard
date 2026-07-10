/**
 * Server-side assignment types — kept aligned with Dashboard/src/lib/equipment/assignmentTypes.ts
 */

import * as admin from 'firebase-admin';
import { ActorRef } from './actor';

export const ASSIGNMENT_ROLES = ['primary_operator', 'relief_operator'] as const;

export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export interface Assignment {
  assignmentId: string;
  companyId: string;
  equipmentId: string;
  driverHash: string;
  assignedBy: ActorRef;
  role: AssignmentRole;
  active: boolean;
  startedAt: string;
  endedAt?: string | null;
  notes?: string;
  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

export type AssignmentDomainEvent =
  | {
      type: 'EquipmentAssigned';
      companyId: string;
      assignmentId: string;
      equipmentId: string;
      driverHash: string;
    }
  | {
      type: 'EquipmentAssignmentEnded';
      companyId: string;
      assignmentId: string;
      equipmentId: string;
      driverHash: string;
    }
  | {
      type: 'EquipmentTransferred';
      companyId: string;
      equipmentId: string;
      previousAssignmentId: string;
      newAssignmentId: string;
      previousDriverHash: string;
      newDriverHash: string;
    };

/** Statuses that block new assignment unless explicitly overridden. */
export const ASSIGNMENT_RESTRICTED_EQUIPMENT_STATUSES = ['in_shop', 'out_of_service'] as const;

export function assignmentsCollection(companyId: string): string {
  return `companies/${companyId}/assignments`;
}

export function reserveAssignmentId(companyId: string): string {
  return admin.firestore().collection(assignmentsCollection(companyId)).doc().id;
}