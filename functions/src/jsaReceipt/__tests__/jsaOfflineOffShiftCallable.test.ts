import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {jsaOfflineShift} from '../jsaOfflineCallable';
import {deriveOffShiftGrant,type OfflineGrant} from '../jsaOfflineCore';
import {resolveJsaWorkPeriod} from '../jsaWorkPeriodStore';
const who={uid:'u',companyId:'c',driverId:'d',app:'wbt'},hour=3600000;
jest.mock('firebase-functions/v2/https',()=>({onCall:(_o:any,h:any)=>h,HttpsError:class extends Error{constructor(public code:string,message:string){super(message);}}}));
jest.mock('firebase-admin',()=>({firestore:jest.fn(),database:jest.fn()}));
jest.mock('../jsaReceiptCore',()=>({parseAuthPrincipal:()=>({ok:true,value:{uid:'u',companyId:'c',driverId:'d',app:'wbt'}})}));
jest.mock('../../sso/ssoCallables',()=>({buildSsoDeps:()=>({getDriver:async()=>({active:true,companyId:'c',driverId:'d'})})}));
jest.mock('../../security/rateLimit',()=>({checkRateLimit:async()=>true}));
jest.mock('../jsaReceiptCallables',()=>({jobDayDeps:()=>({})}));
jest.mock('../jsaWorkPeriodStore',()=>({resolveJsaWorkPeriod:jest.fn()}));
jest.mock('../preparedExecutionProfiles',()=>({readPreparedExecutionProfiles:async()=>[]}));
let docs:Map<string,any>,writes:string[],now:number;
const root:OfflineGrant={version:1,id:'a'.repeat(64),companyId:'c',driverId:'d',issuedAtMs:1000,expiresAtMs:1000+14*hour,shiftId:null,binding:{jsaPeriodId:'b'.repeat(48)},requirementKey:'old',policyDay:'2026-11-24',mode:'off',allowAcknowledge:false,operators:['XTO'],assessments:[],fullReadId:null,offShiftPreparation:{validUntilMs:1000+72*hour,windowMs:14*hour}};
const active='jsa_active_work_periods/'+createHash('sha256').update(JSON.stringify(['c','d'])).digest('hex');
const descriptor={rootGrantId:root.id,periodId:'c'.repeat(48),startedAtMs:1000+14*hour};
const grant=deriveOffShiftGrant(root,descriptor);
const event={version:1,id:'E'.repeat(43),grantId:grant.id,jobRef:'job',operator:'XTO',occurredAtMs:grant.issuedAtMs+100,kind:'off'};
const run=(body:any)=>((jsaOfflineShift as unknown) as Function)({data:body,auth:{uid:'u',token:{}}});
beforeEach(()=>{now=event.occurredAtMs+1000;writes=[];docs=new Map<string,any>([
 ['jsa_offline_grants/'+root.id,root],['invoices/job',{companyId:'c',driverId:'d',operator:'XTO'}],
 ['driver_shift_authority/d',{companyId:'c',driverId:'d',initialized:true,openPeriodId:null,originLocalDate:null,version:1}],
 [active,{id:root.binding.jsaPeriodId,companyId:'c',driverId:'d',shiftId:null,state:'open',createdAtMs:1000}],
 ['companies/c',{jsaMode:'off',assignedOperators:['XTO']}],['jsa_governed_artifacts/previous',{snapshot:{signature:'unchanged'}}]
 ]);
 const snap=(path:string)=>({exists:docs.has(path),data:()=>docs.get(path)}),ref=(path:string)=>({path,get:async()=>snap(path),create:async(v:any)=>{if(docs.has(path))throw Error('already exists');docs.set(path,v);writes.push(path);}});
 (admin.firestore as unknown as jest.Mock).mockReturnValue({doc:ref,runTransaction:async(fn:any)=>{const pending:any[]=[];let writing=false;const result=await fn({get:async(r:any)=>{if(writing)throw Error('read after write');return snap(r.path);},set:(r:any,v:any)=>{writing=true;pending.push([r.path,v]);},create:(r:any,v:any)=>{writing=true;if(docs.has(r.path))throw Error('already exists');pending.push([r.path,v]);}});for(const [p,v]of pending){docs.set(p,v);writes.push(p);}return result;}});
 (admin.database as unknown as jest.Mock).mockReturnValue({ref:()=>({once:async()=>({val:()=>({})})})});
 (resolveJsaWorkPeriod as jest.Mock).mockImplementation(async()=>({...docs.get(active),originDate:'2026-11-24'}));jest.spyOn(Date,'now').mockImplementation(()=>now);
});
afterEach(()=>jest.restoreAllMocks());
test('off-shift preparation succeeds without a shift and freezes a 72h policy plus 14h current period',async()=>{const r=await run({version:1,operation:'prepare'});expect(r.grant.shiftId).toBeNull();expect(r.grant.offShiftPreparation.validUntilMs-now).toBe(72*hour);expect(r.grant.offShiftPeriodEndsAtMs).toBe(1000+14*hour);});
test('real commit adapter replays one derived job once and leaves signed content untouched',async()=>{const body={version:1,operation:'commit',event,offShiftPeriod:descriptor};const r=await run(body);const count=writes.length;expect(await run(body)).toEqual(r);expect(writes).toHaveLength(count);expect([...docs.keys()].filter(k=>k.startsWith('jsa_offline_receipts/'))).toHaveLength(1);expect(docs.get(active).id).toBe(descriptor.periodId);expect(docs.get('jsa_governed_artifacts/previous').snapshot.signature).toBe('unchanged');});
test('refuses overlapping off-shift periods without writing anything',async()=>{docs.set(active,{...docs.get(active),createdAtMs:descriptor.startedAtMs-100});await expect(run({version:1,operation:'commit',event,offShiftPeriod:descriptor})).rejects.toThrow();expect(writes).toEqual([]);});
test('an active real shift refuses new off-shift work; no shift is ended or modified',async()=>{const a=docs.get('driver_shift_authority/d');docs.set('driver_shift_authority/d',{...a,openPeriodId:'2026-11-24_090000',originLocalDate:'2026-11-24'});await expect(run({version:1,operation:'commit',event,offShiftPeriod:descriptor})).rejects.toThrow();expect(writes).toEqual([]);});
test('foreign job cannot replay under a legitimate preparation',async()=>{docs.set('invoices/job',{companyId:'other',driverId:'d',operator:'XTO'});await expect(run({version:1,operation:'commit',event,offShiftPeriod:descriptor})).rejects.toThrow();expect(writes).toEqual([]);});

