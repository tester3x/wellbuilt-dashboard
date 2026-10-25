/** Installed-client compatibility; new WB T uses the JobShift endpoints. */
import {JSA_JOB_ACK_COLLECTION} from '@tester3x/wellbuilt-contracts';
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {buildSsoDeps} from '../sso/ssoCallables';
import {hasHistoricalJobCoverage,companyJsaDay,jobDayPrincipal,resolveJobDayPolicy,type JobDayDeps} from './jsaLegacyJobDayPolicy';
import {decideInvoiceJobFields,parseRegisterInput,fromStored} from './jsaReceiptCore';
import {handleRegister,JsaReceiptError,type ReceiptDeps} from './jsaReceiptHandlers';
const OPTIONS={timeoutSeconds:30,memory:'256MiB' as const,enforceAppCheck:false};
export function createLegacyJobDayCallables(shared:{buildReceiptDeps:()=>ReceiptDeps;limited:(uid:string,bucket:string)=>Promise<void>;authOf:(r:any)=>any;toHttps:(e:unknown)=>httpsV2.HttpsError}){
const {buildReceiptDeps,limited,authOf,toHttps}=shared;
function jobDayDeps():JobDayDeps {
 const db=admin.firestore();return {shift:(d,c)=>buildReceiptDeps().resolveShift(d,c),sso:buildSsoDeps(),nowMs:()=>Date.now(),
  company:async id=>(await db.collection('companies').doc(id).get()).data()||{},
  records:async(company,driver,day,period)=>{
   const snap=await db.collection('jsa_governed_requests').where('companyId','==',company).where('driverId','==',driver).where(period?'binding.associatedPeriodId':'binding.policyDay','==',period||day).get();
   return snap.docs.map(d=>fromStored(d.data())).filter((r):r is NonNullable<typeof r>=>!!r&&!r.binding.jsaPeriodId);
  }};
}
async function ownedJob(p:ReturnType<typeof jobDayPrincipal>,jobRef:string,allowMissing=false){
 const invoice=await buildReceiptDeps().readInvoice(jobRef);
 if(!invoice.exists&&allowMissing)return false;
 const fields=decideInvoiceJobFields({expectedCompanyId:p.companyId,expectedDriverId:p.driverId,invoice:{exists:invoice.exists,...invoice.data}});
 if(!fields.ok)throw new JsaReceiptError('permission-denied','not_owner','job');return true;
}
function jobDayRequest(data:unknown):{jobRef:string} {
 const d=data as Record<string,unknown>;
 if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['protocolVersion','jobRef','purpose'].includes(k))||d.protocolVersion!==1||(d.purpose!==undefined&&!['start','coverage'].includes(String(d.purpose)))||typeof d.jobRef!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(d.jobRef))throw new JsaReceiptError('invalid-argument','malformed','request');
 return {jobRef:d.jobRef};
}
const jobDayAckPath=(company:string,driver:string,job:string,day:string)=>JSA_JOB_ACK_COLLECTION+'/'+createHash('sha256').update(JSON.stringify(['job-day',company,driver,job,day])).digest('hex');
const jsaRegisterJobReadRequest=httpsV2.onCall(OPTIONS,async request=>{
 if(!request.auth?.uid)throw new httpsV2.HttpsError('unauthenticated','not_authorized');
 await limited(request.auth.uid,'jsa_register_job_day');
 try{
  const deps=buildReceiptDeps(),parsed=parseRegisterInput(request.data);
  if(parsed.ok){
   const p=jobDayPrincipal(authOf(request)),old=await deps.readRequest!(parsed.value.requestId);
   if(old&&old.companyId===p.companyId&&old.driverId===p.driverId&&old.binding.shiftState==='independent'){
    const current=await resolveJobDayPolicy(jobDayDeps(),p);
    if(old.binding.policyDay!==current.binding.policyDay && !(current.mode==='per_shift' && current.binding.associatedPeriodId && old.binding.associatedPeriodId===current.binding.associatedPeriodId))throw new JsaReceiptError('failed-precondition','expired','workday_changed');
   }
  }
  const result=await handleRegister({...deps,registerJobDay:true},authOf(request),request.data);
  const stored=await deps.readRequest!(result.requestId);
  return {...result,policyDay:stored?.binding.policyDay};
 }catch(e){throw toHttps(e);}
});
const jsaResolveJobReadEvidence=httpsV2.onCall(OPTIONS,async request=>{
 if(!request.auth?.uid)throw new httpsV2.HttpsError('unauthenticated','not_authorized');
 await limited(request.auth.uid,'jsa_job_day_evidence');
 try{
  const {jobRef}=jobDayRequest(request.data),p=jobDayPrincipal(authOf(request));const jobExists=await ownedJob(p,jobRef,true);
  const deps=jobDayDeps(),cfg=await deps.company(p.companyId);
  // An authoritative Off requirement needs no commercial JSA entitlement, but
  // it still requires a current authenticated member of the selected company.
  if((cfg.jsaMode??'off')==='off'){
   const member=await deps.sso.getDriver(p.driverId);
   if(!member?.active||member.companyId!==p.companyId||member.driverId!==p.driverId)throw new JsaReceiptError('permission-denied','not_owner','membership');
   const day=companyJsaDay(deps.nowMs(),String(cfg.timeZone||cfg.timezone||'America/Chicago'));
   return {protocolVersion:1,policyDay:day,requirementKey:day,hasRead:false,jobSatisfied:false,policy:{mode:'off',allowAcknowledge:false,intent:'read'}};
  }
  const scope=await resolveJobDayPolicy(deps,p),day=scope.binding.policyDay!;
  if((request.data as Record<string,unknown>).purpose==='coverage'){
   const db=admin.firestore();
   const reads=await db.collection('jsa_governed_requests').where('companyId','==',p.companyId).where('driverId','==',p.driverId).where('jobRef','==',jobRef).where('state','==','completed').limit(20).get();
   const acknowledgements=await db.collection(JSA_JOB_ACK_COLLECTION).where('companyId','==',p.companyId).where('driverId','==',p.driverId).where('jobRef','==',jobRef).limit(20).get();
   const linkedCoverage=(await db.doc('jsa_job_read_coverage/'+createHash('sha256').update(JSON.stringify([p.companyId,p.driverId,jobRef])).digest('hex')).get()).data();
   const historical=jobExists&&hasHistoricalJobCoverage(p,jobRef,reads.docs.map(d=>fromStored(d.data())).filter((r):r is NonNullable<typeof r>=>!!r),acknowledgements.docs.map(d=>d.data()),linkedCoverage||null);
   return {protocolVersion:1,policy: {mode:scope.mode},historicalJobSatisfied:historical};
  }

  const rows=scope.rows;
  const ack=(await admin.firestore().doc(jobDayAckPath(p.companyId,p.driverId,jobRef,day)).get()).data();
  const full=rows.some(r=>r.jobRef===jobRef&&r.state==='completed'&&(r.action==='read_and_acknowledged'||scope.style!=='read_and_acknowledge'&&r.action==='read_completed'));
  const ackOk=scope.policy.allowAcknowledge&&ack?.companyId===p.companyId&&ack?.driverId===p.driverId&&ack?.jobRef===jobRef&&ack?.policyDay===day&&ack?.method==='acknowledged';
  return {protocolVersion:1,policyDay:day,requirementKey:scope.requirementKey,hasRead:scope.hasRead,jobSatisfied:jobExists&&(full||ackOk),policy:{mode:scope.mode,allowAcknowledge:scope.style==='acknowledge',intent:scope.style==='read_and_acknowledge'?'read_and_acknowledge':'read'}};
 }catch(e){throw toHttps(e);}
});
const jsaAcknowledgeJobDay=httpsV2.onCall(OPTIONS,async request=>{
 if(!request.auth?.uid)throw new httpsV2.HttpsError('unauthenticated','not_authorized');
 await limited(request.auth.uid,'jsa_ack_job_day');
 try{
  const {jobRef}=jobDayRequest(request.data),p=jobDayPrincipal(authOf(request));await ownedJob(p,jobRef);
  const scope=await resolveJobDayPolicy(jobDayDeps(),p);
  if(!scope.policy.allowAcknowledge)throw new JsaReceiptError('failed-precondition','no_qualifying_read','full_read_required');
  const day=scope.binding.policyDay!,ref=admin.firestore().doc(jobDayAckPath(p.companyId,p.driverId,jobRef,day));
  const state=await admin.firestore().runTransaction(async tx=>{
   const old=(await tx.get(ref)).data();
   if(old){if(old.companyId!==p.companyId||old.driverId!==p.driverId||old.jobRef!==jobRef||old.policyDay!==day||old.method!=='acknowledged')throw new JsaReceiptError('failed-precondition','binding_mismatch','ack');return 'already_recorded';}
   const firstRead=scope.rows.filter(r=>r.state==='completed'&&(r.action==='read_and_acknowledged'||scope.style!=='read_and_acknowledge'&&r.action==='read_completed')).sort((a,b)=>(a.completedAtMs||0)-(b.completedAtMs||0)||a.requestId.localeCompare(b.requestId))[0];
   tx.create(ref,{fullReadId:firstRead?.requestId||null,schemaVersion:1,companyId:p.companyId,driverId:p.driverId,jobRef,policyDay:day,periodId:scope.binding.associatedPeriodId||null,method:'acknowledged',recordedAtMs:Date.now()});return 'recorded';
  });return {protocolVersion:1,state,policyDay:day};
 }catch(e){throw toHttps(e);}
});

/** Link a once-per-scope full read to a particular job without inventing a
 * per-job acknowledgement or asking the driver for another ceremony. */
const jsaRecordJobReadCoverage=httpsV2.onCall(OPTIONS,async request=>{
 if(!request.auth?.uid)throw new httpsV2.HttpsError('unauthenticated','not_authorized');
 await limited(request.auth.uid,'jsa_scope_read_coverage');
 try{
  const {jobRef}=jobDayRequest(request.data),p=jobDayPrincipal(authOf(request));await ownedJob(p,jobRef);
  const scope=await resolveJobDayPolicy(jobDayDeps(),p);
  if(scope.mode!=='per_shift'||!scope.hasRead)throw new JsaReceiptError('failed-precondition','no_qualifying_read','scope_read_required');
  const first=scope.rows.filter(r=>r.companyId===p.companyId&&r.driverId===p.driverId&&r.state==='completed'&&(r.action==='read_and_acknowledged'||scope.style!=='read_and_acknowledge'&&r.action==='read_completed')).sort((a,b)=>(a.completedAtMs||0)-(b.completedAtMs||0))[0];
  if(!first)throw new JsaReceiptError('failed-precondition','no_qualifying_read','scope_read_required');
  const recordId=createHash('sha256').update(JSON.stringify([p.companyId,p.driverId,jobRef])).digest('hex'),ref=admin.firestore().doc('jsa_job_read_coverage/'+recordId);
  await admin.firestore().runTransaction(async tx=>{const prior=(await tx.get(ref)).data();if(prior){if(prior.companyId!==p.companyId||prior.driverId!==p.driverId||prior.jobRef!==jobRef||prior.method!=='scope_read')throw new JsaReceiptError('failed-precondition','binding_mismatch','coverage');return;}tx.create(ref,{schemaVersion:1,companyId:p.companyId,driverId:p.driverId,jobRef,method:'scope_read',fullReadId:first.requestId,requirementKey:scope.requirementKey,policyDay:scope.binding.policyDay,periodId:scope.binding.associatedPeriodId||null,recordedAtMs:Date.now()});});
  return {protocolVersion:1,state:'recorded',recordId};
 }catch(e){throw toHttps(e);}
});

return {jsaRegisterJobReadRequest,jsaResolveJobReadEvidence,jsaAcknowledgeJobDay,jsaRecordJobReadCoverage};
}
