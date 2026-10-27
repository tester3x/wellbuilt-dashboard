/** Explicit user-authorized initial baseline; ETags prevent replacing concurrent real data. */
const fs=require('fs'),path=require('path');
const {seedFreshWaterBaseline}=require('../functions/lib/security/operational/freshWaterSupplyCore');
const {canonicalFreshWaterGroups}=require('../functions/lib/security/operational/canonicalFreshWater');
(async()=>{
 const auth=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
 const acct=auth.getGlobalDefaultAccount(),token=await auth.getAccessToken(acct.tokens.refresh_token,[]);
 const base='https://wellbuilt-sync-default-rtdb.firebaseio.com/';
 async function read(p){const r=await fetch(base+encodeURI(p)+'.json',{headers:{Authorization:'Bearer '+token.access_token,'X-Firebase-ETag':'true'}});if(!r.ok)throw Error('read '+r.status);return {value:await r.json(),etag:r.headers.get('etag')};}
 async function put(p,value,etag){const r=await fetch(base+encodeURI(p)+'.json',{method:'PUT',headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json','if-match':etag},body:JSON.stringify(value)});if(!r.ok)throw Error('conditional write '+r.status);}
 const key='Gabriel FW 1-4-5-6',cfgPath='well_config/'+key,statePath='fresh_water_supply/liquid-gold/gabriel-1-4-5-6';
 const cfg=await read(cfgPath),state=await read(statePath);
 if(cfg.value?.companyId!=='liquid-gold'||cfg.value.inventoryGroupId!=='gabriel-1-4-5-6'||cfg.value.bblPerFoot!==60||cfg.value.tanks!==3)throw Error('canonical identity mismatch');
 const group=canonicalFreshWaterGroups({[key]:cfg.value},'liquid-gold')['gabriel-1-4-5-6'];
 const baseline=seedFreshWaterBaseline(state.value,group.config,{levelFeet:13.5,atUTC:'2026-10-27T19:45:00Z',dailyUseBbl:72,
  provenance:{levelSource:'user supplied approximate 13ft6in observation',timeSource:'user chosen approximate 2026-10-27 14:45 America/Chicago; not verified photo EXIF',rateSource:'initial estimate from programmed cycles: 72 BBL/day; not measured actual use'}});
 const nextConfig={...cfg.value,bottomLevel:8,allowedBottom:8};
 if(process.argv.includes('--apply')) {await put(cfgPath,nextConfig,cfg.etag);await put(statePath,baseline,state.etag);}
 const readback={atUTC:new Date().toISOString(),applied:process.argv.includes('--apply'),config:(await read(cfgPath)).value,state:(await read(statePath)).value};
 fs.writeFileSync('D:/dev/AI-packets/freshwater-followup-baseline-readback-20261027.json',JSON.stringify(readback,null,2));
 console.log(JSON.stringify({applied:readback.applied,groupId:cfg.value.inventoryGroupId,inventoryPreviouslyEmpty:state.value===null,readback:readback.state}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
