/**
 * WB eQuipment — canonical Assignment model (Phase 1C).
 *
 * Assignment means current operational responsibility or custody of equipment.
 * It does not require the custodian to be physically in the equipment at every moment.
 * Future custodians may include shop, yard, or non-driver roles — first implementation
 * is driver-scoped only.
 *
 * Answers one question: "Who currently has custody of this equipment?"
 * Not dispatch history, trip history, maintenance state, workflow state, or documents.
 */

import type { ActorRef } from './metadata';

// ── Custody role (intentionally small) ──────────────────────────────────────
// Equipment type (truck, trailer, pump, etc.) is on the Equipment record — not here.

export const ASSIGNMENT_ROLES = ['primary_operator', 'relief_operator'] as const;

export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ASSIGNMENT_ROLE_LABELS: Record<AssignmentRole, string> = {
  primary_operator: 'Primary Operator',
  relief_operator: 'Relief Operator',
};

// ── Canonical assignment record ─────────────────────────────────────────────
// assignmentId is permanent identity. Relationships use equipmentId + driverHash.
//
// Uniqueness: at most one active assignment per (companyId, equipmentId).
// Enforced server-side in a Firestore transaction — never rely on pre-query + separate write.
//
// Transfer semantics: end current active record + create new record atomically.
// Do not mutate an existing assignment into a new driver's custody.
// Assignment records ARE the history — no separate history collection.

export interface Assignment {
  /** Firestore document ID — permanent identity. */
  assignmentId: string;
  companyId: string;

  /** FK → companies/{companyId}/equipment/{equipmentId} */
  equipmentId: string;

  /** Canonical driver identity — driverHash from RTDB drivers/approved. */
  driverHash: string;

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

/** Input for starting custody — assignmentId may be client-supplied for idempotency. */
export type AssignmentCreateInput = Omit<
  Assignment,
  'assignmentId' | 'active' | 'endedAt' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'
> & {
  assignmentId?: string;
  active?: boolean;
  endedAt?: string | null;
};

/** End custody — sets active=false and stamps endedAt. */
export interface AssignmentEndInput {
  endedAt?: string;
  notes?: string;
}

/** Atomic transfer — ends current active assignment and creates a successor. */
export interface AssignmentTransferInput {
  equipmentId: string;
  driverHash: string;
  role?: AssignmentRole;
  notes?: string;
  /** Client-supplied ID for the successor record (idempotent retries). */
  newAssignmentId?: string;
  /** Override for in_shop / out_of_service equipment — requires authorized actor + reason. */
  overrideRestrictedStatus?: boolean;
  overrideReason?: string;
}

/**
 * Equipment validation when starting or transferring custody:
 * - Equipment document must exist under companyId
 * - Equipment.active must be true
 * - Status ready | needs_service | scheduled → allowed by default
 * - Status in_shop | out_of_service → rejected unless overrideRestrictedStatus + overrideReason
 */