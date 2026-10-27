import * as admin from 'firebase-admin';
import * as https from 'firebase-functions/v2/https';
import { wellBelongsToDriverCompany } from './wbmWellScope';
import { validFreshWaterConfig } from './freshWaterSupplyCore';
/** Shared Add/Edit Well entry point; identity/history are immutable once created. */
export async function writeCanonicalFreshWater(companyId: string, op: string, wellName: string, config: Record<string, unknown>) {
 if (!wellName || wellName.length > 80 || /[.#$\[\]\/]/.test(wellName)) throw new https.HttpsError('invalid-argument', 'invalid_name');
 if (op !== 'create' && op !== 'update') throw new https.HttpsError('failed-precondition', 'Inventory identity cannot be renamed or deleted through an ordinary edit.');
 const allowed = ['routeType','route','tanks','numTanks','tankCapacity','tankHeight','bblPerFoot','equalization','suppliesWells','displayName'];
 if (Object.keys(config).some(k => !allowed.includes(k)) || config.routeType !== 'freshwater'
  || typeof config.route !== 'string' || !config.route.trim() || config.route.length > 100
  || !Array.isArray(config.suppliesWells) || !config.suppliesWells.length || config.suppliesWells.some(n => typeof n !== 'string')
  || typeof config.tankCapacity !== 'number' || typeof config.bblPerFoot !== 'number'
  || config.tankCapacity !== Number(config.tankHeight) * Number(config.bblPerFoot) / Number(config.tanks)
  || !validFreshWaterConfig({ enabled:true,tankCount:config.tanks,tankHeightFeet:config.tankHeight,
   bblPerFootPerTank:Number(config.bblPerFoot)/Number(config.tanks),equalization:config.equalization }))
  throw new https.HttpsError('invalid-argument','invalid_freshwater_geometry_or_members');
 const db=admin.database(), catalog=db.ref('well_config');
 const snapshot=await catalog.once('value'), all=snapshot.val() || {}, existing=all[wellName];
 if (existing && (existing.routeType !== 'freshwater' || existing.companyId !== companyId)) throw new https.HttpsError('permission-denied','existing_inventory_out_of_scope');
 if (op === 'update' && !existing) throw new https.HttpsError('not-found','inventory_not_found');
 if (op === 'create' && existing) throw new https.HttpsError('already-exists','inventory_exists');
 const id=existing?.inventoryGroupId || catalog.push().key!;
 // Existing identity and geometry stay fixed even before the first delivery, preventing a concurrent first-delivery race.
 if (existing && ['tanks','tankHeight','bblPerFoot','equalization'].some(k=>config[k]!==existing[k]))
  throw new https.HttpsError('failed-precondition','inventory_geometry_requires_explicit_migration');
 const state=await db.ref('fresh_water_supply/'+companyId+'/'+id).once('value');
 if (state.exists() && ['tanks','tankHeight','bblPerFoot','equalization'].some(k=>config[k]!==existing?.[k]))
  throw new https.HttpsError('failed-precondition','active_inventory_geometry_requires_migration');
 const next={...existing,...config, route:config.route.trim(), companyId, inventoryGroupId:id, numTanks:config.tanks, displayName:existing?.displayName || wellName};
 let conflict='';
 const result=await catalog.transaction(current=>{
  const rows=current || {};
  if (JSON.stringify(rows[wellName] ?? null)!==JSON.stringify(existing ?? null)) { conflict='concurrent_edit'; return; }
  for (const member of config.suppliesWells as string[]) {
   if (!rows[member] || rows[member].routeType==='freshwater' || !wellBelongsToDriverCompany(rows[member],companyId)) { conflict='member_out_of_scope'; return; }
  }
  for (const [key, value] of Object.entries(rows)) {
   const row=value as Record<string,unknown>;
   if (key===wellName) continue;
   if (row.route===next.route && (row.routeType || 'produced-water')!=='freshwater') { conflict='mixed_route_types'; return; }
   if (row.companyId===companyId && row.routeType==='freshwater' && Array.isArray(row.suppliesWells)
    && row.suppliesWells.some(n=>(config.suppliesWells as string[]).includes(n))) { conflict='duplicate_physical_inventory'; return; }
  }
  return {...rows,[wellName]:next};
 });
 if (!result.committed) throw new https.HttpsError('failed-precondition',conflict || 'catalog_conflict');
 return {ok:true, wellName,created:op==='create',updated:op==='update',idempotent:false,config:next};
}
