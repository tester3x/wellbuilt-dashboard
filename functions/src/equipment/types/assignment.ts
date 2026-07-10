/**
 * Server-side assignment types — kept aligned with Dashboard/src/lib/equipment/assignmentTypes.ts
 */

import * as admin from 'firebase-admin';
import { ActorRef } from './actor';

export const ASSIGNMENT_ROLES = ['operator', 'relief'] as const;

export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export interface Assignment {
  assignmentId: string;
  companyId: string;
  equipmentId: string;
  /** Canonical driver identity — stores driverHash. */
  driverId: string;
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

export function assignmentsCollection(companyId: string): string {
  return `companies/${companyId}/assignments`;
}

export function reserveAssignmentId(companyId: string): string {
  return admin.firestore().collection(assignmentsCollection(companyId)).doc().id;
}