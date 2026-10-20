import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash,randomBytes} from 'node:crypto';
import {issueDeviceAccount,exchangeDeviceAccount,revokeDeviceAccount,refreshDeviceAccount} from '../lib/platform/deviceAccount.js';
const auth={uid:'u',claims:{kind:'driver',driverId:'d',companyId:'c'}};
function world(){const rows=new Map();let now=100000;let active=true,disabled=false,validAfterMs=0;
 const deps={nowMs:()=>now,randomBytes,base64Url:b=>Buffer.from(b).toString('base64url'),sha256Hex:s=>createHash('sha256').update(s).digest('hex'),expiresAtTimestamp:ms=>ms,
  getDriver:async()=>({driverId:'d',companyId:'c',active,displayName:'Driver',legalName:'Legal'}),getAuthStatus:async()=>({disabled,validAfterMs}),
  getCompanyContract:async()=>({state:'active',contract:{planId:'p',appConfiguration:{}}}),getPlan:async()=>({contractVersion:1,planId:'p',displayName:'Plan',capabilities:[],status:'active',apps:{'wellbuilt-equipment':{included:true,requiresActiveShift:true},'wellbuilt-jsa':{included:true},'wellbuilt-mobile':{included:true},'wellbuilt-tickets':{included:false}}}),
  runTransaction:async fn=>fn({get:async p=>({exists:rows.has(p),data:rows.get(p)}),create:(p,v)=>{assert.ok(!rows.has(p));rows.set(p,v);},update:(p,v)=>rows.set(p,{...rows.get(p),...v})}),
  mintCustomToken:async(uid,claims)=>JSON.stringify({uid,claims}),log:()=>{}};
 return {deps,rows,advance:ms=>now+=ms,disable:()=>disabled=true,move:()=>active=false,revokeAuth:()=>validAfterMs=now+1};}
test('server derives access; browsing Equipment ignores shift without widening an excluded app',async()=>{const w=world(),issued=await issueDeviceAccount(w.deps,auth,{version:1});
 assert.ok(issued.access.allowedApps.includes('equipment'));assert.ok(!issued.access.allowedApps.includes('tickets'));
 assert.equal(issued.credential.length,43);assert.ok(!JSON.stringify([...w.rows]).includes(issued.credential));
 const result=await exchangeDeviceAccount(w.deps,{version:1,credential:issued.credential,app:'equipment'});
 assert.equal(result.access.grantId,issued.access.grantId);assert.equal(result.access.establishedAtMs,issued.access.establishedAtMs);
 assert.equal(JSON.parse(result.customToken).claims.app,'equipment');
 await assert.rejects(exchangeDeviceAccount(w.deps,{version:1,credential:issued.credential,app:'tickets'}));});
test('tampered grants, missing authentication and extra authority fields are refused',async()=>{const w=world();
 await assert.rejects(issueDeviceAccount(w.deps,{uid:null,claims:{}},{version:1}));
 await assert.rejects(issueDeviceAccount(w.deps,auth,{version:1,driverId:'other'}));
 await assert.rejects(exchangeDeviceAccount(w.deps,{version:1,credential:'a'.repeat(43),app:'equipment'}));});
for(const cause of ['disable','move','revokeAuth','expire','deviceLogout'])test(cause+' prevents exchange',async()=>{const w=world(),i=await issueDeviceAccount(w.deps,auth,{version:1});
 if(cause==='expire')w.advance(91*86400000);else if(cause==='deviceLogout')await revokeDeviceAccount(w.deps,auth,{version:1,grantId:i.access.grantId});else w[cause]();
 await assert.rejects(exchangeDeviceAccount(w.deps,{version:1,credential:i.credential,app:'equipment'}));});
test('another uid cannot revoke a device grant',async()=>{const w=world(),i=await issueDeviceAccount(w.deps,auth,{version:1});
 await assert.rejects(revokeDeviceAccount(w.deps,{uid:'other',claims:{}},{version:1,grantId:i.access.grantId}));});

test('refresh returns current access without issuing another grant or token',async()=>{
 const w=world(),i=await issueDeviceAccount(w.deps,auth,{version:1});w.advance(300000);
 const refreshed=await refreshDeviceAccount(w.deps,auth,{version:1,grantId:i.access.grantId});
 assert.equal(refreshed.access.grantId,i.access.grantId);assert.ok(refreshed.access.checkedAtMs>i.access.checkedAtMs);assert.equal(w.rows.size,1);assert.equal(refreshed.customToken,undefined);
 await assert.rejects(refreshDeviceAccount(w.deps,{...auth,uid:'another'},{version:1,grantId:i.access.grantId}));
 w.disable();await assert.rejects(refreshDeviceAccount(w.deps,auth,{version:1,grantId:i.access.grantId}));
});
test('native logout capability can revoke after the SDK session was cleared',async()=>{
 const w=world(),i=await issueDeviceAccount(w.deps,auth,{version:1});
 await assert.rejects(revokeDeviceAccount(w.deps,{uid:null,claims:{}},{version:1,grantId:i.access.grantId,credential:'x'.repeat(43)}));
 await revokeDeviceAccount(w.deps,{uid:null,claims:{}},{version:1,grantId:i.access.grantId,credential:i.credential});
 await assert.rejects(exchangeDeviceAccount(w.deps,{version:1,credential:i.credential,app:'equipment'}));
});
test('JSA exchange binds the actual server shift, and never fabricates a missing shift',async()=>{
 const w=world(),i=await issueDeviceAccount(w.deps,auth,{version:1});
 w.deps.getShiftAuthority=async()=>({driverId:'d',companyId:'c',initialized:true,openPeriodId:'2026-10-19_090000',originLocalDate:'2026-10-19'});
 const result=await exchangeDeviceAccount(w.deps,{version:1,credential:i.credential,app:'jsa'});
 assert.equal(result.jsaBinding.periodId,'2026-10-19_090000');
 w.deps.getShiftAuthority=async()=>null;
 await assert.rejects(exchangeDeviceAccount(w.deps,{version:1,credential:i.credential,app:'jsa'}));
 w.deps.getShiftAuthority=async()=>({driverId:'d',companyId:'c',initialized:true,openPeriodId:null,originLocalDate:null});
 assert.equal((await exchangeDeviceAccount(w.deps,{version:1,credential:i.credential,app:'jsa'})).jsaBinding.shiftState,'none');
});
