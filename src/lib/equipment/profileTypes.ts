/**
 * WB eQuipment — Equipment Profile architecture.
 *
 * Equipment Profile is the unified read model for a single equipment asset.
 * Dashboard presents it as "Equipment Profile"; mobile presents assigned assets as "My Equipment".
 * The underlying architecture is identical — only scope and presentation differ.
 *
 * Domain chain (do not merge):
 *   Equipment → Assignment → DVIR → Defect → Maintenance → Shop → Health
 *
 * Health projection (future):
 *   Domain Events → Health Projection → Equipment Summary
 *   healthScore is reserved on Equipment — no service writes it directly.
 */

import type { Assignment } from './assignmentTypes';
import type { AssignmentSource } from './assignmentCompatibility';
import type { Equipment, EquipmentStatus } from './types';

/** Profile sections — each backed by its own domain, linked via equipmentId. */
export type EquipmentProfileSection =
  | 'identity'
  | 'assignment'
  | 'documents'
  | 'compliance'
  | 'status'
  | 'dvir'
  | 'defects'
  | 'maintenance'
  | 'health';

export const EQUIPMENT_PROFILE_SECTIONS: EquipmentProfileSection[] = [
  'identity',
  'assignment',
  'documents',
  'compliance',
  'status',
  'dvir',
  'defects',
  'maintenance',
  'health',
];

export const EQUIPMENT_PROFILE_SECTION_LABELS: Record<EquipmentProfileSection, string> = {
  identity: 'Identity',
  assignment: 'Assignment',
  documents: 'Documents',
  compliance: 'Compliance',
  status: 'Status',
  dvir: 'DVIR',
  defects: 'Defects',
  maintenance: 'Maintenance',
  health: 'Health',
};

/** Identity slice — canonical Equipment registry fields. */
export interface EquipmentProfileIdentity {
  equipmentId: string;
  companyId: string;
  equipmentTypeId: string;
  unitNumber: string;
  displayName?: string;
  make?: string;
  model?: string;
  year?: string;
}

/** Assignment slice — current operational custody only. */
export interface EquipmentProfileAssignment {
  assignmentId: string | null;
  assignmentSource: AssignmentSource;
  driverHash?: string;
  assignmentRole?: Assignment['assignmentRole'];
  assignmentReason?: Assignment['assignmentReason'];
  startedAt?: string;
  active?: boolean;
}

/** Reserved slices — populated as domains are implemented. */
export interface EquipmentProfileDocuments {
  available: boolean;
  documentCount?: number;
}

export interface EquipmentProfileCompliance {
  available: boolean;
}

export interface EquipmentProfileStatus {
  status: EquipmentStatus;
  active: boolean;
}

export interface EquipmentProfileDvir {
  available: boolean;
  dueCount?: number;
}

export interface EquipmentProfileDefects {
  available: boolean;
  openCount?: number;
}

export interface EquipmentProfileMaintenance {
  available: boolean;
}

export interface EquipmentProfileHealth {
  /** Reserved — derived from projection, never written by individual services. */
  healthScore: number | null;
  available: boolean;
}

/**
 * Unified Equipment Profile read model.
 * Callers assemble slices from domain-specific services — no monolithic document.
 */
export interface EquipmentProfile {
  equipmentId: string;
  companyId: string;
  identity: EquipmentProfileIdentity;
  assignment: EquipmentProfileAssignment;
  documents: EquipmentProfileDocuments;
  compliance: EquipmentProfileCompliance;
  status: EquipmentProfileStatus;
  dvir: EquipmentProfileDvir;
  defects: EquipmentProfileDefects;
  maintenance: EquipmentProfileMaintenance;
  health: EquipmentProfileHealth;
}

/** Mobile list item — driver's assigned equipment only (not company fleet). */
export interface MyEquipmentListItem {
  equipmentId: string;
  assignmentId: string | null;
  assignmentSource: AssignmentSource;
  displayLabel: string;
  equipmentTypeId?: string;
  unitNumber?: string;
  assignmentRole?: Assignment['assignmentRole'];
  startedAt?: string;
}

/** Build a minimal profile shell from Equipment + optional Assignment. */
export function buildEquipmentProfileShell(
  equipment: Equipment,
  assignment?: EquipmentProfileAssignment,
): EquipmentProfile {
  const assignmentSlice: EquipmentProfileAssignment = assignment ?? {
    assignmentId: null,
    assignmentSource: 'legacy',
  };

  return {
    equipmentId: equipment.equipmentId,
    companyId: equipment.companyId,
    identity: {
      equipmentId: equipment.equipmentId,
      companyId: equipment.companyId,
      equipmentTypeId: equipment.equipmentTypeId,
      unitNumber: equipment.unitNumber,
      displayName: equipment.displayName,
      make: equipment.make,
      model: equipment.model,
      year: equipment.year,
    },
    assignment: assignmentSlice,
    documents: { available: false },
    compliance: { available: false },
    status: { status: equipment.status, active: equipment.active },
    dvir: { available: false },
    defects: { available: false },
    maintenance: { available: false },
    health: { healthScore: equipment.healthScore ?? null, available: false },
  };
}