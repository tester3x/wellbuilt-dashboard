const profiles=new Map<string,any>(),proofs=new Map<string,any>(),reads:string[]=[];
jest.mock('firebase-functions/v2/https',()=>({onCall:(_o:any,fn:any)=>fn,HttpsError:class extends Error{constructor(public code:string,message:string){super(message);}}}));
jest.mock('firebase-admin',()=>({firestore:()=>({doc:()=>({get:async()=>({data:()=>null})})}),database:()=>({ref:(path:string)=>({once:async()=>{reads.push(path);return {val:()=>path.startsWith('drivers/profiles/')?profiles.get(path.split('/').pop()!):proofs.get(path.split('/').pop()!)};}})})}));
jest.mock('../../admin/authority',()=>({authorizeAdminCall:()=>({ok:false})}));
jest.mock('../trustedStaffAuthority',()=>({requireTrustedCompanyCapability:async(uid:string)=>{if(uid!=='dispatcher')throw Error('permission-denied');return {companyId:'company-a'};}}));
import {staffGetDispatchDriverSignals} from '../dispatchDriverSignals';
import {projectDispatchAccountSignal} from '../dispatchDriverSignalsCore';
const id='canonical-test-driver';
beforeEach(()=>{profiles.clear();proofs.clear();reads.length=0;});
test('only exact authenticated account evidence indicates recent activity; old activity is unknown, never signed out',()=>{
 const now=Date.now(),proof={hydrationDriverId:id,hydrationAt:now-60000};
 expect(projectDispatchAccountSignal(id,proof,{},now).state).toBe('recently_active');
 expect(projectDispatchAccountSignal(id,{...proof,hydrationDriverId:'other'},{},now).state).toBe('unknown');
 expect(projectDispatchAccountSignal(id,{...proof,hydrationAt:now-3600000},{},now).state).toBe('unknown');
 expect(projectDispatchAccountSignal(id,{...proof,hydrationAt:now+3600000},{},now).state).toBe('unknown');
 expect(projectDispatchAccountSignal(id,proof,{logoutAt:now-30000},now).state).toBe('signed_out');
 expect(projectDispatchAccountSignal(id,proof,{logoutAt:now-120000},now).state).toBe('recently_active');
});
test('staff scope is enforced before driver reads; no sign-in inference from shift or job state',async()=>{
 await expect((staffGetDispatchDriverSignals as any)({data:{companyId:'company-a',driverIds:[id]}})).rejects.toThrow('Sign in');
 await expect((staffGetDispatchDriverSignals as any)({auth:{uid:'dispatcher'},data:{companyId:'other',driverIds:[id]}})).rejects.toThrow('scope');expect(reads).toHaveLength(0);
 profiles.set(id,{companyId:'company-a',onShift:true,currentJob:'busy',passcode:'never return'});
 const r=await (staffGetDispatchDriverSignals as any)({auth:{uid:'dispatcher'},data:{companyId:'company-a',driverIds:[id,id]}});
 expect(r.signals[id].state).toBe('unknown');expect(JSON.stringify(r)).not.toContain('never return');expect(reads).toHaveLength(2);
});
test('foreign profile proof is never read and malformed/oversized identifiers are refused',async()=>{
 profiles.set(id,{companyId:'other'});
 const request=(driverIds:any)=>({auth:{uid:'dispatcher'},data:{companyId:'company-a',driverIds}});
 expect((await (staffGetDispatchDriverSignals as any)(request([id]))).signals[id].state).toBe('unknown');expect(reads).toEqual(['drivers/profiles/'+id]);
 await expect((staffGetDispatchDriverSignals as any)(request(['../other']))).rejects.toThrow('canonical');
 await expect((staffGetDispatchDriverSignals as any)(request(Array(201).fill(id)))).rejects.toThrow('canonical');
});
