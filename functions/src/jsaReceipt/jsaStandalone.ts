import { WELLBUILT_APP_JSA } from '@tester3x/wellbuilt-contracts';
import { createHash } from 'crypto';
import { parseAuthPrincipal, requireAudience, JSA_APP_JSA } from './jsaReceiptCore';
import { parseArtifactInput } from './jsaArtifactCore';
import { decideAppEntitlementAuthorization } from '../sso/appEntitlementAuthorization';
import type { SsoDeps } from '../sso/ssoDeps';
export class StandaloneError extends Error {
  constructor(public code: 'unauthenticated'|'permission-denied'|'invalid-argument'|'not-found'|'already-exists',message:string){super(message);}
}
export interface StandaloneStore {
  list(path:string,after:string|null):Promise<Record<string,unknown>[]>;
  transaction(path:string,update:(old:Record<string,unknown>|null)=>Record<string,unknown>|null):Promise<Record<string,unknown>>;
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function bad():never{throw new StandaloneError('invalid-argument','malformed');}
function text(v:unknown,max:number,required=false):string{if(typeof v!=='string'||v.length>max||v!==v.trim()||(required&&!v))bad();return v;}
/** Independent record authoring: no shift, day-status or required-job receipt. */
export async function handleStandalone(deps:Pick<SsoDeps,'getDriver'|'getCompanyContract'|'getPlan'>,store:StandaloneStore,auth:{uid?:string|null;claims?:Record<string,unknown>|null},raw:unknown,now:number):Promise<Record<string,unknown>>{
 const parsed=parseAuthPrincipal(auth);
 if(!parsed.ok)throw new StandaloneError(auth.uid?'permission-denied':'unauthenticated','authentication');
 const p=parsed.value;
 if(!requireAudience(p,JSA_APP_JSA).ok)throw new StandaloneError('permission-denied','audience');
 const driver=await deps.getDriver(p.driverId);
 if(!driver?.active||driver.driverId!==p.driverId||driver.companyId!==p.companyId)throw new StandaloneError('permission-denied','company_membership');
 const contract=await deps.getCompanyContract(p.companyId);
 const plan=contract.contract?await deps.getPlan(contract.contract.planId):null;
 const access=decideAppEntitlementAuthorization({app:WELLBUILT_APP_JSA,contractState:contract.state,contract:contract.contract,plan,shift:null});
 // Explicit standalone product policy: only the shift requirement is inapplicable.
 // Commercial exclusion, company disable, and malformed policy remain denials.
 if(!access.ok&&access.refusal!=='active_shift_required')throw new StandaloneError('permission-denied','company_permission');
 if(!object(raw))bad();
 const op=raw.operation;
 const allowed=op==='create'?['operation','recordId','snapshot','job']:op==='list'?['operation','after']:op==='access'?['operation']:['operation','recordId'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)))bad();
 if(op==='access')return {allowed:true,companyId:p.companyId,driverId:p.driverId,requiresActiveShift:false};
 const path=`jsa_standalone_companies/${hash(p.companyId)}/drivers/${hash(p.driverId)}/records`;
 if(op==='list'){
   const after=raw.after===undefined?null:text(raw.after,43,true);
   if(after&&!/^[A-Za-z0-9_-]{43}$/.test(after))bad();
   return {records:await store.list(path,after)};
 }
 const id=text(raw.recordId,43,true);
 if(!/^[A-Za-z0-9_-]{43}$/.test(id)||!['create','get','close'].includes(String(op)))bad();
 let authored:Record<string,unknown>|null=null;
 if(op==='create'){
   // Reuse the deployed immutable-artifact validator; id is only a validation key.
   const a=parseArtifactInput({requestId:id,snapshot:raw.snapshot});
   if(!a.ok||!a.value.snapshot.stepsAcknowledged||!Object.keys(a.value.snapshot.stepAcks).length||Object.values(a.value.snapshot.stepAcks).some(v=>!v))bad();
   if(!object(raw.job)||Object.keys(raw.job).some(k=>!['activity','wells'].includes(k)))bad();
   const activity=text(raw.job.activity,200,true);
   if(!Array.isArray(raw.job.wells)||raw.job.wells.length>100)bad();
   const wells=raw.job.wells.map(w=>{if(!object(w)||Object.keys(w).some(k=>!['name','jobType','operator','county'].includes(k)))bad();return {name:text(w.name,300,true),jobType:text(w.jobType,200),operator:text(w.operator,300),county:text(w.county,100)};});
   const content={snapshot:a.value.snapshot,job:{activity,wells}};
   authored={...content,contentHash:hash(JSON.stringify(content)),id,companyId:p.companyId,driverId:p.driverId,workflow:'standalone',shiftId:null,state:'open',signedAtMs:now};
 }
 const record=await store.transaction(`${path}/${id}`,old=>{
   if(old&&(old.companyId!==p.companyId||old.driverId!==p.driverId||old.workflow!=='standalone'))throw new StandaloneError('permission-denied','owner');
   if(op==='create'){
     if(old&&old.contentHash!==authored!.contentHash)throw new StandaloneError('already-exists','conflicting_record');
     return old?null:authored;
   }
   if(!old)throw new StandaloneError('not-found','record');
   return op==='close'&&old.state!=='closed'?{...old,state:'closed',closedAtMs:now}:null;
 });
 return {record};
}

