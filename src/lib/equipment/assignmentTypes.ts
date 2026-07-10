/**
 * WB eQuipment — canonical Assignment model (Phase 1C foundation).
 *
 * Answers one question only: "Who currently has custody of this equipment?"
 * Not dispatch history, maintenance history, workflow state, or trip history.
 */

import type { ActorRef } from './metadata';

// ── Custody role (intentionally small) ──────────────────────────────────────

export const ASSIGNMENT_ROLES = ['operator', 'relief'] as const;

export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ASSIGNMENT_ROLE_LABELS: Record<AssignmentRole, string> = {
  operator: 'Operator',
  relief: 'Relief',
};

// ── Canonical assignment record ─────────────────────────────────────────────
// assignmentId is permanent identity. Relationships use equipmentId + driverId.

export interface Assignment {
  /** Firestore document ID — permanent identity. */
  assignmentId: string;
  companyId: string;

  /** FK → companies/{companyId}/equipment/{equipmentId} */
  equipmentId: string;

  /**
   * Canonical driver identity (stores driverHash from RTDB drivers/approved).
   * Field name is driverId — ecosystem-wide logical identity, not a Firestore doc path.
   */
  driverId: string;

  /** Who created or last transferred this custody record. */
  assignedBy: ActorRef;

  role: AssignmentRole;

  /** true = current custody; false = ended historical record. */
  active: boolean;

  /** ISO timestamp when custody began. */
  startedAt: string;

  /** ISO timestamp when custody ended; null/omitted while active. */
  endedAt?: string | null;

  notes?: string;

  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

/** Input for starting custody — assignmentId assigned at persist time. */
export type AssignmentCreateInput = Omit<
  Assignment,
  'assignmentId' | 'active' | 'endedAt' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'
> & {
  active?: boolean;
  endedAt?: string | null;
};

/** Partial update — identity and equipment/driver links immutable after create. */
export type AssignmentUpdateInput = Partial<
  Pick<Assignment, 'role' | 'notes' | 'assignedBy'>
>;

/** End custody — sets active=false and stamps endedAt. */
export interface AssignmentEndInput {
  endedAt?: string;
  notes?: string;
}