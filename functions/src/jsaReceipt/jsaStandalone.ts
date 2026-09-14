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
 const allowed=op==='append'?['operation','recordId','additionId','addition']:op==='create'?['operation','recordId','snapshot','job']:op==='list'?['operation','after']:op==='access'?['operation']:['operation','recordId'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)))bad();
 if(op==='access')return {allowed:true,companyId:p.companyId,driverId:p.driverId,requiresActiveShift:false};
 const path=`jsa_standalone_companies/${hash(p.companyId)}/drivers/${hash(p.driverId)}/records`;
 if(op==='list'){
   const after=raw.after===undefined?null:text(raw.after,43,true);
   if(after&&!/^[A-Za-z0-9_-]{43}$/.test(after))bad();
   return {records:await store.list(path,after)};
 }
 const id=text(raw.recordId,43,true);
 if(!/^[A-Za-z0-9_-]{43}$/.test(id)||!['create','get','close','append'].includes(String(op)))bad();
 let addition:Record<string,unknown>|null=null;
 if(op==='append'){
   const additionId=text(raw.additionId,43,true);
   if(!/^[A-Za-z0-9_-]{43}$/.test(additionId)||!object(raw.addition))bad();
   const a=raw.addition;
   if(Object.keys(a).some(k=>!['location','operator','activity','hazards','controls','ppe','acknowledged','baseContentHash','expectedAdditionCount'].includes(k)))bad();
   if(a.acknowledged!==true||!Number.isInteger(a.expectedAdditionCount)||Number(a.expectedAdditionCount)<0)bad();
   const content={location:text(a.location,300,true),operator:text(a.operator,300),activity:text(a.activity,200,true),hazards:text(a.hazards,2000,true),controls:text(a.controls,2000,true),ppe:text(a.ppe,1000,true),acknowledged:true,baseContentHash:text(a.baseContentHash,64,true),expectedAdditionCount:a.expectedAdditionCount};
   addition={...content,id:additionId,contentHash:hash(JSON.stringify(content)),acknowledgedAtMs:now,acknowledgedByUid:auth.uid,driverId:p.driverId,
     acknowledgement:'I have reviewed this location and activity, assessed its hazards, and understand the controls and PPE needed before starting work.'};
 }
 let authored:Record<string,unknown>|null=null;
 if(op==='create'){
   // Reuse the deployed immutable-artifact validator; id is only a validation key.
   const a=parseArtifactInput({requestId:id,snapshot:raw.snapshot});
   if(!a.ok||!a.value.snapshot.stepsAcknowledged||!Object.keys(a.value.snapshot.stepAcks).length||Object.values(a.value.snapshot.stepAcks).some(v=>!v))bad();
   if(!object(raw.job)||Object.keys(raw.job).some(k=>!['activity','wells','operator','assessmentSteps'].includes(k)))bad();
   const activity=text(raw.job.activity,200,true);
   if(!Array.isArray(raw.job.wells)||raw.job.wells.length>100)bad();
   const wells=raw.job.wells.map(w=>{if(!object(w)||Object.keys(w).some(k=>!['name','jobType','operator','county'].includes(k)))bad();return {name:text(w.name,300,true),jobType:text(w.jobType,200),operator:text(w.operator,300),county:text(w.county,100)};});
   const extra:Record<string,unknown>={};
   if(raw.job.operator!==undefined)extra.operator=text(raw.job.operator,300,true);
   if(raw.job.assessmentSteps!==undefined){
     if(!Array.isArray(raw.job.assessmentSteps)||!raw.job.assessmentSteps.length||raw.job.assessmentSteps.length>40)bad();
     const stepIds=new Set<string>();
     extra.assessmentSteps=raw.job.assessmentSteps.map(s=>{
       if(!object(s)||Object.keys(s).some(k=>!['id','title','items'].includes(k))||!Array.isArray(s.items)||s.items.length>30)bad();
       const id=text(s.id,64,true);if(a.value.snapshot.stepAcks[id]!==true||stepIds.has(id))bad();stepIds.add(id);
       return {id,title:text(s.title,300,true),items:s.items.map(i=>{
         if(!object(i)||Object.keys(i).some(k=>!['hazard','controls'].includes(k)))bad();
         return {hazard:text(i.hazard,2000,true),controls:text(i.controls,4000,true)};
       })};
     });
     if(stepIds.size!==Object.keys(a.value.snapshot.stepAcks).length||JSON.stringify(extra.assessmentSteps).length>100000)bad();
   }
   const content={snapshot:a.value.snapshot,job:{activity,wells,...extra}};
   authored={...content,contentHash:hash(JSON.stringify(content)),id,companyId:p.companyId,driverId:p.driverId,workflow:'standalone',shiftId:null,state:'open',signedAtMs:now};
 }
 const record=await store.transaction(`${path}/${id}`,old=>{
   if(old&&(old.companyId!==p.companyId||old.driverId!==p.driverId||old.workflow!=='standalone'))throw new StandaloneError('permission-denied','owner');
   if(op==='create'){
     if(old&&old.contentHash!==authored!.contentHash)throw new StandaloneError('already-exists','conflicting_record');
     return old?null:authored;
   }
   if(!old)throw new StandaloneError('not-found','record');
   if(op==='append'){
     const additions=Array.isArray(old.additions)?old.additions as Record<string,unknown>[]:[];
     const existing=additions.find(a=>a.id===addition!.id);
     // Retry after close still returns the original acknowledgement, never a new write.
     if(existing){if(existing.contentHash!==addition!.contentHash)throw new StandaloneError('already-exists','conflicting_addition');return null;}
     if(old.state!=='open')throw new StandaloneError('permission-denied','record_closed');
     const job=old.job as Record<string,unknown>;
     if(job.operator && addition!.operator!==job.operator)throw new StandaloneError('invalid-argument','different_customer_requires_new_jsa');
     if(old.contentHash!==addition!.baseContentHash||additions.length!==addition!.expectedAdditionCount)throw new StandaloneError('already-exists','review_latest_record');
     if(additions.length>=40)throw new StandaloneError('invalid-argument','addition_limit');
     return {...old,additions:[...additions,addition!]};
   }
   return op==='close'&&old.state!=='closed'?{...old,state:'closed',closedAtMs:now}:null;
 });
 return {record};
}

