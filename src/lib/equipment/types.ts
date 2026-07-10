/**
 * WB eQuipment — canonical equipment model (Phase 1B).
 * Source of truth for Dashboard and mobile consumers.
 * Long-term destination: equipment_documents keyed by equipmentId.
 */

import type { ActorRef } from './metadata';

// ── Operational status (intentionally small) ────────────────────────────────
// Workflow detail belongs in Defects / Maintenance — not Equipment itself.

export const EQUIPMENT_STATUSES = [
  'ready',
  'needs_service',
  'scheduled',
  'in_shop',
  'out_of_service',
] as const;

export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const EQUIPMENT_STATUS_LABELS: Record<EquipmentStatus, string> = {
  ready: 'Ready',
  needs_service: 'Needs Service',
  scheduled: 'Scheduled',
  in_shop: 'In Shop',
  out_of_service: 'Out of Service',
};

// ── Configurable equipment types ────────────────────────────────────────────
// Truck and trailer are seed types only — schema supports future asset classes.

export interface EquipmentType {
  /** Stable type key, e.g. "truck", "trailer", "pump", "generator". */
  typeId: string;
  companyId: string;
  label: string;
  /** Optional icon key for UI (Material icon name, emoji, etc.). */
  icon?: string;
  /** Future: which spec fields apply to this type. */
  specSchema?: string[];
  /** Future: default DVIR template for this type. */
  dvirTemplateId?: string;
  active: boolean;
  sortOrder?: number;
  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

// ── Canonical equipment record ──────────────────────────────────────────────
// equipmentId is permanent identity. unitNumber is display/search only.

export interface Equipment {
  /** Firestore document ID — permanent identity. Never derived from unitNumber. */
  equipmentId: string;
  companyId: string;

  /** FK → equipment_types.typeId */
  equipmentTypeId: string;

  /**
   * Human-facing unit number for search and display (e.g. "4608", "T-15").
   * NOT a foreign key — may change without breaking document/DVIR/defect links.
   */
  unitNumber: string;

  /** Optional friendly label, e.g. "Unit 14 — Peterbilt 389". */
  displayName?: string;

  status: EquipmentStatus;
  /** Fleet roster flag — inactive units hidden from default lists. */
  active: boolean;

  // Denormalized display hints (not canonical specs — those live in specs subdoc later)
  make?: string;
  model?: string;
  year?: string;

  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

/** Input for creating equipment — equipmentId assigned at persist time. */
export type EquipmentCreateInput = Omit<
  Equipment,
  'equipmentId' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'
>;

/** Partial update — identity fields immutable after create. */
export type EquipmentUpdateInput = Partial<
  Pick<Equipment, 'unitNumber' | 'displayName' | 'status' | 'active' | 'make' | 'model' | 'year'>
>;