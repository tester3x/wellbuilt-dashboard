const docs=new Map<string,any>(),profiles=new Map<string,any>();
jest.mock('firebase-functions/v2/https',()=>({onCall:(_o:any,fn:any)=>fn,HttpsError:class extends Error{constructor(public code:string,message:string){super(message);}}}));
jest.mock('firebase-admin',()=>({firestore:()=>({doc:(path:string)=>({path}),runTransaction:async(fn:any)=>{
 const pending:Array<()=>void>=[];
 const result=await fn({get:async(ref:any)=>({exists:docs.has(ref.path),data:()=>docs.get(ref.path)}),create:(ref:any,v:any)=>pending.push(()=>docs.set(ref.path,structuredClone(v))),update:(ref:any,v:any)=>pending.push(()=>{docs.get(ref.path).waterOrder.sent=v['waterOrder.sent'];})});pending.forEach(f=>f());return result;
}}),database:()=>({ref:(path:string)=>({once:async()=>({val:()=>profiles.get(path.split('/').pop()!)})})})}));
jest.mock('../trustedStaffAuthority',()=>({requireTrustedCompanyCapability:async(uid:string,cap:string)=>{if(uid!=='dispatcher'||cap!=='manageDrivers')throw Error('permission-denied');return {companyId:'company-a'};}}));
import {staffWriteWaterOrder} from '../staffWriteWaterOrder';
const orderId='water_fixture',dispatchId='wo_water_fixture_1',driverId='canonical-fixture-driver';
const fixture=()=>({id:orderId,companyId:'company-a',draft:{name:'Test',destination:'Test drop',notes:'test',tanks:[{id:'tank'}],truckKeys:['roster-key']},plan:{version:1,createdAt:new Date().toISOString(),deadline:new Date(Date.now()+86400000).toISOString(),target:40,existing:0,needed:40,planned:40,shortfall:0,sources:[{operator:'Test customer'}],trips:[{id:dispatchId,wellName:'Test Well',driverKey:'roster-key',bbl:40}]},records:{[dispatchId]:{dispatchId,projectId:orderId,wellName:'Test Well',bbls:40,disposal:'Test drop',jobType:'pw',status:'pending',loadCount:1,driverId}},sent:[]});
const call=(b:any,uid='dispatcher')=>(staffWriteWaterOrder as any)({auth:{uid},data:{companyId:'company-a',orderId,...b}});
beforeEach(()=>{docs.clear();profiles.clear();profiles.set(driverId,{active:true,companyId:'company-a'});});
test('save uses trusted company/actor and retries identical immutable plan',async()=>{
 const value=fixture(),first=await call({op:'save',value});expect(first.order.id).toBe(orderId);expect(docs.get('projects/'+orderId).createdBy).toBe('dispatcher');
 docs.get('projects/'+orderId).waterOrder.sent=[dispatchId];expect((await call({op:'save',value})).order.sent).toEqual([dispatchId]);expect(docs.size).toBe(1);
 value.draft.destination='Changed';value.records[dispatchId].disposal='Changed';await expect(call({op:'save',value})).rejects.toThrow('Saved order changed');
});
test('anonymous, missing capability, cross-company, impersonated fields and inactive drivers are refused',async()=>{
 await expect(call({op:'save',value:fixture()},'driver')).rejects.toThrow('permission-denied');
 await expect(call({op:'save',value:fixture(),companyId:'company-b'})).rejects.toThrow('authorized');
 await expect(call({op:'save',value:fixture(),role:'owner'})).rejects.toThrow('Unexpected');
 profiles.set(driverId,{companyId:'company-b',active:true});await expect(call({op:'save',value:fixture()})).rejects.toThrow('Driver');
 profiles.set(driverId,{companyId:'company-a',active:false});await expect(call({op:'save',value:fixture()})).rejects.toThrow('Driver');expect(docs.size).toBe(0);
});
test('frozen records must exactly match trip identities, quantity and destination',async()=>{
 for(const field of ['projectId','wellName','bbls','disposal','driverId']){const value=fixture();(value.records[dispatchId] as any)[field]=field==='bbls'?41:'../foreign';await expect(call({op:'save',value})).rejects.toThrow('Trip');}
 const value=fixture();value.sent=[dispatchId] as never[];await expect(call({op:'save',value})).rejects.toThrow('Invalid');expect(docs.size).toBe(0);
});
test('only confirmed matching dispatch can acknowledge; retry is idempotent',async()=>{
 const value=fixture();await call({op:'save',value});await expect(call({op:'acknowledge',dispatchId})).rejects.toThrow('not been confirmed');
 const job={...value.records[dispatchId],companyId:'company-b'};docs.set('dispatches/'+dispatchId,job);await expect(call({op:'acknowledge',dispatchId})).rejects.toThrow('not been confirmed');
 job.companyId='company-a';job.bbls=50;await expect(call({op:'acknowledge',dispatchId})).rejects.toThrow('not been confirmed');
 job.bbls=40;expect((await call({op:'acknowledge',dispatchId})).order.sent).toEqual([dispatchId]);expect((await call({op:'acknowledge',dispatchId})).order.sent).toEqual([dispatchId]);
});
test('malformed, oversized and expired plans never create projects',async()=>{
 const value=fixture();value.plan.deadline=new Date(0).toISOString();await expect(call({op:'save',value})).rejects.toThrow('plan');
 const large=fixture();large.draft.notes='x'.repeat(901000);await expect(call({op:'save',value:large})).rejects.toThrow('oversized');
 await expect(call({op:'save',value:fixture(),orderId:'../other'})).rejects.toThrow('authorized');expect(docs.size).toBe(0);
});
