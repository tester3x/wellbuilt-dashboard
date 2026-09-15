import { WELLBUILT_APP_JSA } from '@tester3x/wellbuilt-contracts';
import { createHash } from 'crypto';
import { parseAuthPrincipal, requireAudience, JSA_APP_JSA } from './jsaReceiptCore';
import { parseArtifactInput } from './jsaArtifactCore';
import { decideAppEntitlementAuthorization } from '../sso/appEntitlementAuthorization';
import type { SsoDeps } from '../sso/ssoDeps';
import { readJsaTaskCatalog, selectJsaTaskTemplates } from './jsaTaskCatalog';
export class StandaloneError extends Error {
  constructor(public code: 'unauthenticated'|'permission-denied'|'invalid-argument'|'not-found'|'already-exists',message:string){super(message);}
}
export interface StandaloneStore {
  readCatalog?(companyId:string):Promise<Awaited<ReturnType<typeof readJsaTaskCatalog>>>;
  readRecord?(path:string):Promise<Record<string,unknown>|null>;
  readTemplate?(path:string):Promise<Record<string,unknown>|null>;
  list(path:string,after:string|null):Promise<Record<string,unknown>[]>;
  transaction(path:string,update:(old:Record<string,unknown>|null)=>Record<string,unknown>|null):Promise<Record<string,unknown>>;
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const catalogFor=(store:StandaloneStore,companyId:string)=>store.readCatalog?store.readCatalog(companyId):readJsaTaskCatalog({readTemplate:path=>store.readTemplate!(path)},companyId);
function bad():never{throw new StandaloneError('invalid-argument','malformed');}
// Hash the submitted JSON independently of the mutable catalog. Object key order
// is irrelevant, but array order and every submitted value remain significant.
function requestHash(value:unknown):string{
 const canonical=(v:unknown,depth=0):string=>{
   if(depth>32)bad();
   if(v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v)))return JSON.stringify(v);
   if(Array.isArray(v))return '['+v.map(x=>canonical(x,depth+1)).join(',')+']';
   if(object(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k],depth+1)).join(',')+'}';
   return bad();
 };
 const encoded=canonical(value);if(encoded.length>500000)bad();return hash(encoded);
}
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
 const allowed=op==='append'?['operation','recordId','additionId','addition']:op==='create'?['operation','recordId','snapshot','job']:op==='list'?['operation','after']:op==='access'||op==='templates'?['operation']:['operation','recordId'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)))bad();
 if(op==='access')return {allowed:true,companyId:p.companyId,driverId:p.driverId,requiresActiveShift:false};
 if(op==='templates'){
   if(!store.readTemplate)throw new StandaloneError('not-found','template_reader_unavailable');
   const catalog=await catalogFor(store,p.companyId);
   return {...catalog,companyId:p.companyId,driverId:p.driverId};
 }
 const path=`jsa_standalone_companies/${hash(p.companyId)}/drivers/${hash(p.driverId)}/records`;
 if(op==='list'){
   const after=raw.after===undefined?null:text(raw.after,43,true);
   if(after&&!/^[A-Za-z0-9_-]{43}$/.test(after))bad();
   return {records:await store.list(path,after)};
 }
 const id=text(raw.recordId,43,true);
 if(!/^[A-Za-z0-9_-]{43}$/.test(id)||!['create','get','close','append'].includes(String(op)))bad();
 const submittedHash=op==='create'||op==='append'?requestHash(raw):null;
 const checkOwner=(old:Record<string,unknown>)=>{
   if(old.companyId!==p.companyId||old.driverId!==p.driverId||old.workflow!=='standalone')throw new StandaloneError('permission-denied','owner');
 };
 const matchesSavedRequest=(old:Record<string,unknown>):boolean=>{
   const saved=op==='create'?old:(Array.isArray(old.additions)?old.additions:[]).find(a=>a.id===raw.additionId);
   if(!saved?.submittedRequestHash)return false; // Legacy records retain content-hash validation below.
   if(saved.submittedRequestHash!==submittedHash)throw new StandaloneError('already-exists',op==='create'?'conflicting_record':'conflicting_addition');
   return true;
 };
 // Recover an already accepted write before consulting today's task catalog.
 // Authentication, membership and entitlement have still been checked above.
 if(submittedHash&&store.readRecord){
   const saved=await store.readRecord(`${path}/${id}`);
   if(saved){checkOwner(saved);if(matchesSavedRequest(saved))return {record:saved};}
 }
 let addition:Record<string,unknown>|null=null;
 if(op==='append'){
   const additionId=text(raw.additionId,43,true);
   if(!/^[A-Za-z0-9_-]{43}$/.test(additionId)||!object(raw.addition))bad();
   const a=raw.addition;
   if(Object.keys(a).some(k=>!['location','operator','activity','hazards','controls','ppe','acknowledged','baseContentHash','expectedAdditionCount','taskReview'].includes(k)))bad();
   if(a.acknowledged!==true||!Number.isInteger(a.expectedAdditionCount)||Number(a.expectedAdditionCount)<0)bad();
   let taskAssessment:Record<string,unknown>|null=null;
   if(a.taskReview!==undefined){
     if(!object(a.taskReview)||Object.keys(a.taskReview).some(k=>!['templateRefs','stepAcks'].includes(k))||!object(a.taskReview.stepAcks)||!store.readTemplate)bad();
     const catalog=await catalogFor(store,p.companyId);
     const selected=selectJsaTaskTemplates(catalog,a.taskReview.templateRefs);
     const acks=a.taskReview.stepAcks;
     if(Object.keys(acks).length!==selected.steps.length||selected.steps.some(s=>acks[s.id]!==true))bad();
     taskAssessment={...selected,stepAcks:acks};
   }
   const content={location:text(a.location,300,true),operator:text(a.operator,300),activity:text(a.activity,200,true),hazards:text(a.hazards,2000,true),controls:text(a.controls,2000,true),ppe:text(a.ppe,1000,true),acknowledged:true,baseContentHash:text(a.baseContentHash,64,true),expectedAdditionCount:a.expectedAdditionCount,...(taskAssessment?{taskAssessment}: {})};
   addition={...content,id:additionId,submittedRequestHash:submittedHash,contentHash:hash(JSON.stringify(content)),acknowledgedAtMs:now,acknowledgedByUid:auth.uid,driverId:p.driverId,
     acknowledgement:'I have reviewed this location and activity, assessed its hazards, and understand the controls and PPE needed before starting work.'};
 }
 let authored:Record<string,unknown>|null=null;
 if(op==='create'){
   // Reuse the deployed immutable-artifact validator; id is only a validation key.
   const a=parseArtifactInput({requestId:id,snapshot:raw.snapshot});
   if(!a.ok||!a.value.snapshot.stepsAcknowledged||!Object.keys(a.value.snapshot.stepAcks).length||Object.values(a.value.snapshot.stepAcks).some(v=>!v))bad();
   if(!object(raw.job)||Object.keys(raw.job).some(k=>!['activity','wells','operator','assessmentSteps','templateRefs'].includes(k)))bad();
   const activity=text(raw.job.activity,200,true);
   if(!Array.isArray(raw.job.wells)||raw.job.wells.length>100)bad();
   const wells=raw.job.wells.map(w=>{if(!object(w)||Object.keys(w).some(k=>!['name','jobType','operator','county'].includes(k)))bad();return {name:text(w.name,300,true),jobType:text(w.jobType,200),operator:text(w.operator,300),county:text(w.county,100)};});
   const extra:Record<string,unknown>={};
   if(raw.job.templateRefs!==undefined){
     if(!store.readTemplate)throw new StandaloneError('not-found','template_reader_unavailable');
     const catalog=await catalogFor(store,p.companyId);
     const selected=selectJsaTaskTemplates(catalog,raw.job.templateRefs);
     if(JSON.stringify(raw.job.assessmentSteps)!==JSON.stringify(selected.steps))bad();
     const ppeIds=new Set(selected.ppeItems.map(p=>p.id)),preparedIds=new Set(selected.preparedItems.map(p=>p.id));
     if(Object.keys(a.value.snapshot.ppeSelected).some(k=>!ppeIds.has(k))||Object.keys(a.value.snapshot.prepared).some(k=>!preparedIds.has(k)))bad();
     extra.assessmentTemplates=selected.templates;
     extra.assessmentPpeItems=selected.ppeItems;
     extra.assessmentPreparedItems=selected.preparedItems;
   }
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
   authored={...content,submittedRequestHash:submittedHash,contentHash:hash(JSON.stringify(content)),id,companyId:p.companyId,driverId:p.driverId,workflow:'standalone',shiftId:null,state:'open',signedAtMs:now};
 }
 const record=await store.transaction(`${path}/${id}`,old=>{
   if(old){checkOwner(old);if(submittedHash&&matchesSavedRequest(old))return null;}
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
     if(addition!.taskAssessment){
       const reviewed=[...(Array.isArray(job.assessmentTemplates)?job.assessmentTemplates:[]),...additions.flatMap(a=>{
         const review=a.taskAssessment as Record<string,unknown>|undefined;
         return Array.isArray(review?.templates)?review.templates:[];
       })] as {contentHash:string}[];
       const incoming=(addition!.taskAssessment as {templates:{contentHash:string}[]}).templates;
       if(incoming.some(t=>reviewed.some(old=>old.contentHash===t.contentHash)))throw new StandaloneError('invalid-argument','assessment_already_reviewed');
     }
     if(job.operator && addition!.operator!==job.operator)throw new StandaloneError('invalid-argument','different_customer_requires_new_jsa');
     if(old.contentHash!==addition!.baseContentHash||additions.length!==addition!.expectedAdditionCount)throw new StandaloneError('already-exists','review_latest_record');
     if(additions.length>=40)throw new StandaloneError('invalid-argument','addition_limit');
     return {...old,additions:[...additions,addition!]};
   }
   return op==='close'&&old.state!=='closed'?{...old,state:'closed',closedAtMs:now}:null;
 });
 return {record};
}

