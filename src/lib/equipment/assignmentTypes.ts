/**
 * WB eQuipment — canonical Assignment model (Phase 1C).
 *
 * Assignment means current operational responsibility or custody of equipment.
 * It does not require the custodian to be physically in the equipment at every moment.
 * Future custodians may include shop, yard, or non-driver roles — first implementation
 * is driver-scoped only.
 *
 * Custodian identity uses driverHash today. The service layer is designed so
 * driverHash can later resolve through membershipId without changing surrounding
 * architecture: Equipment → Assignment → (future Membership → Person).
 *
 * Answers one question: "Who currently has custody of this equipment?"
 * Not dispatch, maintenance, workflow, trip history, repair history, or inspection history.
 */

import type { ActorRef } from './metadata';

// ── Assignment role (distinct from Employee/platform roles) ──────────────────
// Employee roles: dispatcher, driver, mechanic, administrator, etc.
// Assignment roles: primary_operator, relief_operator, etc.
// Equipment type (truck, trailer, pump) lives on Equipment — not here.

export const ASSIGNMENT_ROLES = ['primary_operator', 'relief_operator'] as const;

export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ASSIGNMENT_ROLE_LABELS: Record<AssignmentRole, string> = {
  primary_operator: 'Primary Operator',
  relief_operator: 'Relief Operator',
};

/** Reserved — no business logic in Phase 1C. Avoids future schema revision. */
export const ASSIGNMENT_REASONS = [
  'normal',
  'temporary',
  'loaner',
  'shop',
  'training',
  'road_test',
  'other',
] as const;

export type AssignmentReason = (typeof ASSIGNMENT_REASONS)[number];

// ── Canonical assignment record ─────────────────────────────────────────────
// assignmentId is permanent identity. Relationships use equipmentId + driverHash.
//
// Uniqueness: at most one active assignment per (companyId, equipmentId).
// Enforced server-side in a Firestore transaction — never rely on pre-query + separate write.
//
// Transfer semantics: end current active record + create new record atomically.
// Assignment records ARE the history — no separate history collection.

export interface Assignment {
  assignmentId: string;
  companyId: string;
  equipmentId: string;
  driverHash: string;
  assignedBy: ActorRef;
  assignmentRole: AssignmentRole;
  /** Reserved — optional until business rules are defined. */
  assignmentReason?: AssignmentReason | null;
  active: boolean;
  startedAt: string;
  endedAt?: string | null;
  notes?: string;
  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

export type AssignmentCreateInput = Omit<
  Assignment,
  'assignmentId' | 'active' | 'endedAt' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'
> & {
  assignmentId?: string;
  active?: boolean;
  endedAt?: string | null;
};

export interface AssignmentEndInput {
  endedAt?: string;
  notes?: string;
}

export interface AssignmentTransferInput {
  equipmentId: string;
  driverHash: string;
  assignmentRole?: AssignmentRole;
  assignmentReason?: AssignmentReason | null;
  notes?: string;
  newAssignmentId?: string;
  overrideRestrictedStatus?: boolean;
  overrideReason?: string;
}