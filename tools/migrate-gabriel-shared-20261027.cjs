'use strict';
const assert=require('node:assert/strict');
const IDS=['gabriel-1-4-5-6','gabriel-2','gabriel-3-7'];
const KEYS=['Gabriel FW 1-4-5-6','Gabriel FW 2','Gabriel FW 3-7'];
const DRIVERS=['2cad521c-13ac-4b6c-b1ab-07843c6bf06f','99ff4b35-51ab-4d45-8d54-18b3b8515c9b'];
const ROUTE="Gabriel's FW's",OLD="Gabriel's FW";
function plan(wells,groups,profiles) {
 assert.deepEqual(Object.keys(groups || {}).sort(),[...IDS].sort(),'Unexpected freshwater inventory config; stop for review');
 const patch={};
 IDS.forEach((id,i)=>{
  const group=groups[id],c=group.config;
  assert.equal(group.routeName,OLD); assert.equal(c.tankHeightFeet,20); assert.equal(c.bblPerFootPerTank,20);
  assert.equal(c.tankCount,i===0?3:1); assert.equal(c.equalization,i===0?'verified-equalized':'single-tank');
  assert.ok(!Object.hasOwn(wells,KEYS[i]),'Destination exists');
  for(const member of group.wellNames) assert.ok(wells[member] && (!wells[member].companyId || wells[member].companyId==='liquid-gold'),'Member company mismatch');
  patch['well_config/'+KEYS[i]]={route:ROUTE,routeType:'freshwater',companyId:'liquid-gold',
    displayName:i===0?'Gabriel 1/4/5/6':i===1?'Gabriel 2':'Gabriel 3/7',operator:'Slawson',
    inventoryGroupId:id,suppliesWells:group.wellNames,tanks:c.tankCount,numTanks:c.tankCount,
    tankCapacity:400,tankHeight:20,bblPerFoot:c.tankCount*20,equalization:c.equalization};
  patch['fresh_water_groups/liquid-gold/'+id]=null;
 });
 DRIVERS.forEach(id=>{
  const profile=profiles[id];assert.equal(profile.companyId,'liquid-gold');assert.equal(profile.active,true);
  assert.ok(Array.isArray(profile.assignedRoutes),'Cannot infer missing production assignment');
  assert.deepEqual(profile.assignedFreshWaterRoutes,[OLD]);
  patch['drivers/profiles/'+id+'/assignedRoutes']=[...new Set([...profile.assignedRoutes,ROUTE])];
  patch['drivers/profiles/'+id+'/assignedFreshWaterRoutes']=null;
  patch['drivers/profiles/'+id+'/assignmentRevision']=(Number(profile.assignmentRevision)||0)+1;
  patch['drivers/profiles/'+id+'/assignmentUpdatedAt']=new Date().toISOString();
 });
 return patch;
}
module.exports={plan,IDS,KEYS,DRIVERS,ROUTE};
if(require.main===module)(async()=>{
 const fs=require('fs'),path=require('path'),auth=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
 const account=auth.getGlobalDefaultAccount();if(!account)throw Error('Firebase CLI login required');
 const token=await auth.getAccessToken(account.tokens.refresh_token, []);
 const endpoint='https://wellbuilt-sync-default-rtdb.firebaseio.com';
 async function call(key,method='GET',body) {
  const response=await fetch(endpoint+'/'+key+'.json',{method,headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error(method+' '+key+' HTTP '+response.status);
  return response.json();
 }
 const [wells,groups,supply,...driverValues]=await Promise.all([call('well_config'),call('fresh_water_groups/liquid-gold'),call('fresh_water_supply/liquid-gold'),...DRIVERS.map(id=>call('drivers/profiles/'+id))]);
 const profiles=Object.fromEntries(DRIVERS.map((id,i)=>[id,driverValues[i]]));
 if(Object.values(wells).some(w=>w?.freshWaterSupply?.enabled))throw Error('Legacy per-well freshwater config requires explicit reconciliation');
 if(Object.keys(supply || {}).some(id=>!IDS.includes(id)))throw Error('Unexpected inventory ledger requires review');
 const patch=plan(wells,groups,profiles);
 const summary={project:'wellbuilt-sync',at:new Date().toISOString(),mode:process.argv.includes('--apply')?'apply':'dry-run',paths:Object.keys(patch),physicalGroups:IDS.length,inventoryBefore:supply==null?'unknown-empty':'present-preserved'};
 if(process.argv.includes('--apply')) {
  // One atomic multi-location update. Ledger paths and production records never appear in the patch.
  await call('','PATCH',patch);
  for(const key of KEYS)assert.deepEqual(await call('well_config/'+key),patch['well_config/'+key]);
  assert.equal(await call('fresh_water_groups/liquid-gold'),null);
  assert.deepEqual(await call('fresh_water_supply/liquid-gold'),supply);
  for(const id of DRIVERS){const now=await call('drivers/profiles/'+id);assert.deepEqual(now.assignedRoutes,patch['drivers/profiles/'+id+'/assignedRoutes']);assert.equal(now.assignedFreshWaterRoutes,undefined);assert.deepEqual(now.assignedWells,profiles[id].assignedWells);}
  const after=await call('well_config');for(const [key,value]of Object.entries(wells))assert.deepEqual(after[key],value,'Production config changed: '+key);
  summary.readback='passed: groups moved once, ledger unchanged, existing well configs unchanged, assignments preserved';
 }
 fs.writeFileSync('D:/dev/AI-packets/freshwater-shared-migration-20261027-'+summary.mode+'.json',JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
