/**
 * Assignment compatibility — server mirror of Dashboard/src/lib/equipment/assignmentCompatibility.ts
 */

import { LEGACY_MOBILE_STORE_KEYS } from './compatibility';

export { LEGACY_MOBILE_STORE_KEYS };

export type CustodyMigrationStage = 'M0_legacy' | 'M1_hybrid' | 'M2_canonical';

export interface LegacyCustodyContext {
  driverHash?: string;
  truckNumber?: string;
  trailerNumber?: string;
  truckEquipmentId?: string;
  trailerEquipmentId?: string;
}

export function hasCanonicalEquipmentId(equipmentId?: string | null): equipmentId is string {
  return typeof equipmentId === 'string' && equipmentId.length > 0;
}

export function inferCustodyMigrationStage(ctx: LegacyCustodyContext): CustodyMigrationStage {
  const hasTruckId = hasCanonicalEquipmentId(ctx.truckEquipmentId);
  const hasTrailerId = hasCanonicalEquipmentId(ctx.trailerEquipmentId);
  const hasAnyId = hasTruckId || hasTrailerId;
  const hasAnyNumber = Boolean(ctx.truckNumber?.trim() || ctx.trailerNumber?.trim());

  if (!hasAnyNumber && !hasAnyId) return 'M0_legacy';
  if (hasAnyId) {
    const truckReady = !ctx.truckNumber?.trim() || hasTruckId;
    const trailerReady = !ctx.trailerNumber?.trim() || hasTrailerId;
    if (truckReady && trailerReady) return 'M2_canonical';
  }
  if (hasAnyNumber || hasAnyId) return 'M1_hybrid';
  return 'M0_legacy';
}