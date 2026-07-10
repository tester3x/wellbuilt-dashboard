/**
 * Assignment compatibility — bridge legacy mobile custody (SecureStore unit numbers)
 * to canonical Assignment records keyed by equipmentId + driverHash.
 *
 * resolveLegacyCustody() is compatibility context only — it must NOT pretend an
 * Assignment record exists when it does not. Mobile UI should distinguish:
 *   - Canonical assignment (M2)
 *   - Legacy inferred assignment (M0/M1)
 *
 * During M1, downstream domains (DVIR, Defect) may reference:
 *   equipmentId, driverHash, assignmentId: null, assignmentSource: 'legacy'
 * until canonical assignments are established. Do not write DVIR against a fake assignmentId.
 *
 * Do NOT use legacy unit numbers as permanent foreign keys in new Assignment writes.
 */

import {
  LEGACY_MOBILE_STORE_KEYS,
  hasCanonicalEquipmentId,
  resolveLegacyAssignment,
  type LegacyAssignmentContext,
  type LegacyAssignmentLookup,
} from './compatibility';

export { LEGACY_MOBILE_STORE_KEYS };

/** How custody was resolved for display or downstream context. */
export type AssignmentSource = 'canonical' | 'legacy';

/** Migration stage for custody resolution. */
export type CustodyMigrationStage = 'M0_legacy' | 'M1_hybrid' | 'M2_canonical';

export interface LegacyCustodyContext extends LegacyAssignmentContext {
  /** Authenticated driver identity (driverHash). */
  driverHash?: string;
}

export interface ResolvedCustodySlot {
  equipmentTypeId: 'truck' | 'trailer';
  unitNumber: string;
  legacyKey: string;
  equipmentId?: string;
  /** null during M0/M1 — no canonical Assignment doc yet. */
  assignmentId?: string | null;
  assignmentSource: AssignmentSource;
}

export interface LegacyCustodySnapshot {
  driverHash?: string;
  stage: CustodyMigrationStage;
  slots: ResolvedCustodySlot[];
}

export function inferCustodyMigrationStage(ctx: LegacyCustodyContext): CustodyMigrationStage {
  const hasTruckId = hasCanonicalEquipmentId(ctx.truckEquipmentId);
  const hasTrailerId = hasCanonicalEquipmentId(ctx.trailerEquipmentId);
  const hasAnyId = hasTruckId || hasTrailerId;
  const lookup = resolveLegacyAssignment(ctx);
  const hasAnyNumber = Boolean(lookup.truck || lookup.trailer);

  if (!hasAnyNumber && !hasAnyId) return 'M0_legacy';
  if (hasAnyId && (!lookup.truck || hasTruckId) && (!lookup.trailer || hasTrailerId)) {
    return 'M2_canonical';
  }
  if (hasAnyNumber || hasAnyId) return 'M1_hybrid';
  return 'M0_legacy';
}

/**
 * Build a custody snapshot from legacy mobile context (no Firestore reads).
 * Does not create or imply Assignment records.
 */
export function resolveLegacyCustody(ctx: LegacyCustodyContext): LegacyCustodySnapshot {
  const lookup = resolveLegacyAssignment(ctx);
  const stage = inferCustodyMigrationStage(ctx);
  const slots: ResolvedCustodySlot[] = [];

  if (lookup.truck) {
    slots.push({
      equipmentTypeId: 'truck',
      unitNumber: lookup.truck.unitNumber,
      legacyKey: lookup.truck.legacyKey,
      equipmentId: hasCanonicalEquipmentId(ctx.truckEquipmentId) ? ctx.truckEquipmentId : undefined,
      assignmentId: null,
      assignmentSource: 'legacy',
    });
  }
  if (lookup.trailer) {
    slots.push({
      equipmentTypeId: 'trailer',
      unitNumber: lookup.trailer.unitNumber,
      legacyKey: lookup.trailer.legacyKey,
      equipmentId: hasCanonicalEquipmentId(ctx.trailerEquipmentId) ? ctx.trailerEquipmentId : undefined,
      assignmentId: null,
      assignmentSource: 'legacy',
    });
  }

  return {
    driverHash: ctx.driverHash?.trim().toLowerCase() || undefined,
    stage,
    slots,
  };
}

export function canWriteCanonicalAssignment(
  slot: ResolvedCustodySlot,
  driverHash?: string,
): slot is ResolvedCustodySlot & { equipmentId: string } {
  return hasCanonicalEquipmentId(slot.equipmentId) && Boolean(driverHash?.trim());
}

export function legacyLookupToCustodySlots(lookup: LegacyAssignmentLookup): ResolvedCustodySlot[] {
  const slots: ResolvedCustodySlot[] = [];
  if (lookup.truck) {
    slots.push({
      equipmentTypeId: 'truck',
      unitNumber: lookup.truck.unitNumber,
      legacyKey: lookup.truck.legacyKey,
      assignmentId: null,
      assignmentSource: 'legacy',
    });
  }
  if (lookup.trailer) {
    slots.push({
      equipmentTypeId: 'trailer',
      unitNumber: lookup.trailer.unitNumber,
      legacyKey: lookup.trailer.legacyKey,
      assignmentId: null,
      assignmentSource: 'legacy',
    });
  }
  return slots;
}

export const CUSTODY_COMPATIBILITY_NOTES = [
  'M0: Mobile SecureStore unit numbers imply custody — no Assignment collection docs',
  'M1: equipmentId cached in SecureStore alongside unit numbers; assignmentId remains null',
  'M2: Assignment records are source of truth; mobile reads active assignments via eQuipmentAssignments',
  'Legacy unit numbers remain display-only; equipmentId is the FK for all new writes',
  'DVIR/Defect during M1: equipmentId + driverHash + assignmentId:null + assignmentSource:legacy',
] as const;