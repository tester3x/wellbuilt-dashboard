import type { FreshWaterConfig } from './freshWaterSupplyCore';
export type CanonicalTankGroup = { routeName: string; name: string; wellNames: string[]; config: FreshWaterConfig };
/** Config belongs to well_config; immutable group IDs retain their original ledger. */
export function canonicalFreshWaterGroups(wells: Record<string, Record<string, unknown>>, companyId: string): Record<string, CanonicalTankGroup> {
 const out: Record<string, CanonicalTankGroup> = {};
 for (const [key, well] of Object.entries(wells)) {
  if (well.routeType !== 'freshwater' || well.companyId !== companyId || typeof well.inventoryGroupId !== 'string') continue;
  const id = well.inventoryGroupId;
  if (out[id]) throw new Error('duplicate_inventory_group');
  out[id] = { routeName: String(well.route || ''), name: String(well.displayName || key),
   wellNames: Array.isArray(well.suppliesWells) ? well.suppliesWells : [],
   config: { enabled: true, tankCount: Number(well.tanks), tankHeightFeet: Number(well.tankHeight),
    bblPerFootPerTank: Number(well.bblPerFoot) / Number(well.tanks),
    equalization: well.equalization as FreshWaterConfig['equalization'], dailyUseBbl: null } };
 }
 return out;
}
