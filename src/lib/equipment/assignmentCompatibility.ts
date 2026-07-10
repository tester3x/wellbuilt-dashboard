/**
 * Assignment compatibility — bridge legacy mobile custody (SecureStore unit numbers)
 * to canonical Assignment records keyed by equipmentId + driverId.
 *
 * During migration (M0–M2):
 * - eWallet stores wbew_truckNumber / wbew_trailerNumber locally (implicit custody)
 * - No Assignment documents exist yet
 * - vehicle_documents still query by equipmentType + unitNumber strings
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

/** Migration stage for custody resolution. */
export type CustodyMigrationStage = 'M0_legacy' | 'M1_hybrid' | 'M2_canonical';

export interface LegacyCustodyContext extends LegacyAssignmentContext {
  /** Authenticated driver identity (driverHash). */
  driverId?: string;
}

export interface ResolvedCustodySlot {
  equipmentTypeId: 'truck' | 'trailer';
  unitNumber: string;
  legacyKey: string;
  equipmentId?: string;
}

export interface LegacyCustodySnapshot {
  driverId?: string;
  stage: CustodyMigrationStage;
  slots: ResolvedCustodySlot[];
}

/**
 * Infer migration stage from available identity fields.
 * M0 = unit numbers only; M1 = partial equipmentId; M2 = equipmentId on all slots.
 */
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
 * Build a custody snapshot from legacy mobile context.
 * Used until eQuipmentAssignments callable is wired (no Firestore reads).
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
    });
  }
  if (lookup.trailer) {
    slots.push({
      equipmentTypeId: 'trailer',
      unitNumber: lookup.trailer.unitNumber,
      legacyKey: lookup.trailer.legacyKey,
      equipmentId: hasCanonicalEquipmentId(ctx.trailerEquipmentId) ? ctx.trailerEquipmentId : undefined,
    });
  }

  return {
    driverId: ctx.driverId?.trim().toLowerCase() || undefined,
    stage,
    slots,
  };
}

/**
 * Whether a slot is ready for canonical Assignment writes (requires equipmentId + driverId).
 */
export function canWriteCanonicalAssignment(
  slot: ResolvedCustodySlot,
  driverId?: string,
): slot is ResolvedCustodySlot & { equipmentId: string } {
  return hasCanonicalEquipmentId(slot.equipmentId) && Boolean(driverId?.trim());
}

/** Map legacy lookup entry to a custody slot descriptor. */
export function legacyLookupToCustodySlots(lookup: LegacyAssignmentLookup): ResolvedCustodySlot[] {
  const slots: ResolvedCustodySlot[] = [];
  if (lookup.truck) {
    slots.push({
      equipmentTypeId: 'truck',
      unitNumber: lookup.truck.unitNumber,
      legacyKey: lookup.truck.legacyKey,
    });
  }
  if (lookup.trailer) {
    slots.push({
      equipmentTypeId: 'trailer',
      unitNumber: lookup.trailer.unitNumber,
      legacyKey: lookup.trailer.legacyKey,
    });
  }
  return slots;
}

export const CUSTODY_COMPATIBILITY_NOTES = [
  'M0: Mobile SecureStore unit numbers imply custody — no Assignment collection docs',
  'M1: equipmentId cached in SecureStore (wbew_truckEquipmentId / wbew_trailerEquipmentId) alongside unit numbers',
  'M2: Assignment records are source of truth; mobile reads via eQuipmentAssignments callable',
  'Legacy unit numbers remain display-only; equipmentId is the FK for all new writes',
] as const;