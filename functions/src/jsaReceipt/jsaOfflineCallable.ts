import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {randomBytes,createHash} from 'crypto';
import {parseAuthPrincipal} from './jsaReceiptCore';
import {buildSsoDeps} from '../sso/ssoCallables';
import {companyJsaDay,resolveJobDayPolicy} from './jsaJobDayPolicy';
import {jobDayDeps} from './jsaReceiptCallables';
import {resolveJsaWorkPeriod} from './jsaWorkPeriodStore';
import {readJsaTaskCatalog} from './jsaTaskCatalog';
import {offlineDefaultAssessment} from './jsaOfflineDefault';
import {offlineHash,validateOfflineEvent,type OfflineGrant,type OfflineEvent,type OfflineAssessment} from './jsaOfflineCore';
import {jsaNumber} from './jsaNumber';
import {checkRateLimit} from '../security/rateLimit';
import {projectOfflineLocations} from './jsaOfflineLocations';

/** New endpoint: does not replace or repackage the live composed Start callable. */
export const jsaOfflineShift=https.onCall({timeoutSeconds:60,memory:'256MiB',enforceAppCheck:false},async request=>{
 const principal=parseAuthPrincipal({uid:request.auth?.uid,claims:request.auth?.token});
 if(!principal.ok||![null,'wbs','wbt','jsa'].includes(principal.value.app))throw new https.HttpsError('permission-denied','driver_session_required');
 const p=principal.value,sso=buildSsoDeps(),member=await sso.getDriver(p.driverId);
 if(!member?.active||member.companyId!==p.companyId||member.driverId!==p.driverId)throw new https.HttpsError('permission-denied','membership_changed');
 if(!await checkRateLimit({bucket:'jsa_offline_shift',key:p.uid,limit:180,windowMs:600000}))throw new https.HttpsError('resource-exhausted','retry_later');
 const b=request.data,db=admin.firestore();
 if(!b||b.version!==1||!['prepare','commit','project_locations'].includes(b.operation))throw new https.HttpsError('invalid-argument','invalid_offline_operation');
 if(b.operation==='prepare'){
  if(Object.keys(b).some(k=>!['version','operation'].includes(k)))throw new https.HttpsError('invalid-argument','invalid_prepare');
  const cfg=(await db.doc('companies/'+p.companyId).get()).data()||{};
  const day=companyJsaDay(Date.now(),String(cfg.timeZone||cfg.timezone||'America/Chicago'));
  const context=await resolveJsaWorkPeriod(p.companyId,p.driverId,day);
  if(!context.shiftId||context.state!=='open')throw new https.HttpsError('failed-precondition','start_shift_before_preparing');
  const scope=cfg.jsaMode==='off'||cfg.jsaMode===undefined?null:await resolveJobDayPolicy(jobDayDeps(),p);
  if(scope&&scope.binding.jsaPeriodId!==context.id)throw new https.HttpsError('failed-precondition','shift_changed');
  const profile=(await admin.database().ref('drivers/profiles/'+p.driverId).once('value')).val()||{};
  const customers=Array.isArray(profile.assignedCustomers)?profile.assignedCustomers:[];
  const operators=[...new Set<string>([...(Array.isArray(cfg.assignedOperators)?cfg.assignedOperators:[]),...customers.map((c:any)=>c?.name)]
    .filter((s:unknown):s is string=>typeof s==='string'&&!!s.trim()).map((s:string)=>s.trim()))].sort();
  if(!operators.length||operators.length>100)throw new https.HttpsError('failed-precondition','operator_scope_unavailable');
  const catalog=scope?await readJsaTaskCatalog({readTemplate:async path=>(await db.doc(path).get()).data()||null},p.companyId):{schemaVersion:1,templates:[]};
  let assessments:OfflineAssessment[]=[];
  if(!scope){assessments=[];}else if(catalog.schemaVersion===2){
   assessments=catalog.templates.map(t=>({...t,steps:t.steps as any[],ppeItems:t.ppeItems as any[],preparedItems:t.preparedItems as any[],packageId:t.packageId as string|null,tasks:t.tasks as string[]}));
   if(!assessments.length)throw new https.HttpsError('failed-precondition','assessment_catalog_empty');
  }else{
   const mirror=(await db.doc('jsa_templates/'+p.companyId).get()).data();
   const content=mirror?.status==='active'?{name:mirror.name,steps:mirror.steps,ppeItems:mirror.ppeItems,preparedItems:mirror.preparedItems}:offlineDefaultAssessment;
   if(!Array.isArray(content.steps)||!content.steps.length||!Array.isArray(content.ppeItems)||!Array.isArray(content.preparedItems)||!content.preparedItems.length)throw new https.HttpsError('failed-precondition','assessment_unavailable');
   assessments=[{...JSON.parse(JSON.stringify(content)),contentHash:offlineHash(content),packageId:null,tasks:[]}];
  }
  const photoRequirements:Record<string,any>={};
  await Promise.all(operators.map(async operator=>{
   const slug=operator.toLowerCase().replace(/[^a-z0-9]/g,'');const spec=(await db.doc('photo_requirements/'+slug).get()).data();
   photoRequirements[slug]=!spec?{cacheSchema:1,status:'not_configured',spec:null}:{customerId:slug,version:typeof spec.version==='number'?spec.version:0,enabled:spec.enabled!==false,
    requirements:(Array.isArray(spec.requirements)?spec.requirements:[]).filter((r:any)=>r&&typeof r.id==='string').map((r:any)=>Object.fromEntries(['id','label','description','threshold','requiredCount','phase','appliesTo','active','sampleUrl'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]])))};
  }));
  const settingsKeys=['requirePhotos','minPhotoCount','aiPhotoAdvisoryMode','jsaMode','jsaJobPolicy','jsaAllowAcknowledge','customJobTypes','assignedOperators','name','shortCode','invoiceBook','splitTickets','invoicingMode','invoiceConsolidation','splitTimeAllocation','cancelledNumberHandling','midnightCutoff','allowedWells','allowedDisposals','transferRequiresApproval','liveDispatchSync','activePackages','invoicePrefix','ticketPrefix','rateSheet'];
  const jobSettings={id:p.companyId,companyId:p.companyId,...Object.fromEntries(settingsKeys.filter(k=>cfg[k]!==undefined).map(k=>[k,cfg[k]]))};
  const id=randomBytes(32).toString('hex'),issuedAtMs=Date.now();
  const first=scope?.rows.filter(r=>r.state==='completed'&&r.action==='read_and_acknowledged').sort((a,b)=>(a.completedAtMs||0)-(b.completedAtMs||0))[0];
  const grant:OfflineGrant={version:1,id,companyId:p.companyId,driverId:p.driverId,issuedAtMs,expiresAtMs:issuedAtMs+72*3600000,
   shiftId:context.shiftId,binding:scope?.binding||{shiftState:'independent',jsaPeriodId:context.id,associatedPeriodId:context.shiftId,policyDay:context.originDate,jsaEnabled:false,requiresActiveShift:false},
   requirementKey:scope?.requirementKey||'jsa:'+context.id,policyDay:context.originDate,mode:(scope?.mode||'off') as OfflineGrant['mode'],
   allowAcknowledge:scope?.style==='acknowledge'&&cfg.jsaAllowAcknowledge!==false,jobSettings,photoRequirements,operators,assessments,fullReadId:first?.requestId||null};
  if(JSON.stringify(grant).length>430000)throw new https.HttpsError('failed-precondition','assessment_bundle_too_large');
  await db.doc('jsa_offline_grants/'+id).create(grant);
  return {version:1,grant};
 }
 if(Object.keys(b).some(k=>!['version','operation','event'].includes(k))||!b.event||typeof b.event.grantId!=='string'||!/^[a-f0-9]{64}$/.test(b.event.grantId)||!/^[A-Za-z0-9_-]{43}$/.test(b.event.id))throw new https.HttpsError('invalid-argument','invalid_commit');
 const e=b.event as OfflineEvent;
 if(b.operation==='project_locations'){
  if(typeof e.jobRef!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(e.jobRef))throw new https.HttpsError('invalid-argument','invalid_job_ref');
  try{return await projectOfflineLocations(db,p,e);}catch(error){
   if(String((error as Error)?.message).startsWith('location_projection_'))throw new https.HttpsError('permission-denied','location_evidence_unconfirmed');
   throw new https.HttpsError('unavailable','Location update remains pending.');
  }
 }
 try{return await db.runTransaction(async tx=>{
  const grant=(await tx.get(db.doc('jsa_offline_grants/'+e.grantId))).data() as OfflineGrant|undefined;
  if(!grant||grant.companyId!==p.companyId||grant.driverId!==p.driverId)throw new https.HttpsError('permission-denied','grant_owner');
  const receipt=db.doc('jsa_offline_receipts/'+e.id),prior=(await tx.get(receipt)).data();
  const eventHash=offlineHash(e);
  if(prior){if(prior.eventHash!==eventHash||prior.companyId!==p.companyId||prior.driverId!==p.driverId)throw Error('immutable_event');return {version:1,state:'confirmed',eventId:e.id,eventHash,recordId:prior.recordId};}
  const [jobSnap,periodSnap,readSnap]=await Promise.all([
   tx.get(db.doc('invoices/'+e.jobRef)),tx.get(db.doc('jsa_work_periods/'+grant.binding.jsaPeriodId)),
   e.fullReadId&&/^[A-Za-z0-9_-]{43}$/.test(e.fullReadId)?tx.get(db.doc('jsa_governed_requests/'+e.fullReadId)):Promise.resolve(null),
  ]);
  const job=jobSnap.data(),checked=validateOfflineEvent(grant,e,job,periodSnap.data(),readSnap?.data(),Date.now());
  const stop={wellName:String(job?.wellName||''),operator:String(job?.operator||''),jobType:String(job?.commodityType||job?.jobType||''),dropOff:String(job?.hauledTo||job?.disposalName||job?.dropOff||'')};
  let recordId=e.id;
  const readRef=db.doc('jsa_governed_requests/'+e.id),artifactRef=db.doc('jsa_governed_artifacts/'+e.id);
  const existingRead=e.kind==='read'?await tx.get(readRef):null,existingArtifact=e.kind==='read'?await tx.get(artifactRef):null;
  if(existingRead?.exists||existingArtifact?.exists)throw Error('record_identity_conflict');
  if(e.kind==='read'&&checked.snapshot){
   const signed=checked.snapshot;
   const row={schemaVersion:1,requestId:e.id,jobRef:e.jobRef,groupRef:null,intent:'read_and_acknowledge',driverId:p.driverId,companyId:p.companyId,binding:grant.binding,
    state:'completed',action:'read_and_acknowledged',receiptHandle:randomBytes(32).toString('base64url'),createdAtMs:e.occurredAtMs,completedAtMs:e.occurredAtMs,
    expiresAtMs:grant.expiresAtMs,wbtConsumedAtMs:null,jsaNumber:jsaNumber('JSA-'+e.id,e.occurredAtMs),offlineGrantId:grant.id,assessmentHash:e.assessmentHash};
   // Artifact format remains consumable by existing saved/weekly JSA readers.
   tx.create(readRef,row);
   tx.create(artifactRef,{schemaVersion:1,requestId:e.id,companyId:p.companyId,driverId:p.driverId,actorUidHash:createHash('sha256').update(p.uid).digest('hex'),jobRef:e.jobRef,groupRef:null,binding:grant.binding,
    action:row.action,snapshotHash:offlineHash(signed.snapshot),snapshot:signed.snapshot,signature:{mimeType:'image/png',encoding:'base64',byteSize:signed.signatureBytes.length,sha256:createHash('sha256').update(signed.signatureBytes).digest('hex')},artifactWrittenAtMs:Date.now()});
  }else if(e.kind!=='off'){
   const acknowledged=e.kind==='acknowledged';
   recordId=createHash('sha256').update(JSON.stringify(acknowledged?['job-day',p.companyId,p.driverId,e.jobRef,grant.requirementKey]:[p.companyId,p.driverId,e.jobRef,grant.requirementKey])).digest('hex');
   const ref=db.doc((acknowledged?'jsa_job_acknowledgments/':'jsa_job_read_coverage/')+recordId);
   // All transaction reads precede writes (the full-read branch writes elsewhere).
   const old=(await tx.get(ref)).data();
   if(old&&(old.companyId!==p.companyId||old.driverId!==p.driverId||old.jobRef!==e.jobRef||old.fullReadId!==e.fullReadId))throw Error('coverage_conflict');
   if(!old)tx.create(ref,{schemaVersion:1,job:stop,companyId:p.companyId,driverId:p.driverId,jobRef:e.jobRef,method:checked.method,fullReadId:e.fullReadId,
    requirementKey:grant.requirementKey,policyDay:grant.policyDay,periodId:grant.shiftId,jsaPeriodId:grant.binding.jsaPeriodId,recordedAtMs:e.occurredAtMs,offlineGrantId:grant.id,
    jsaNumber:jsaNumber('JSA-'+(acknowledged&&grant.mode==='per_job'?recordId.toUpperCase():e.fullReadId),e.occurredAtMs)});
  }
  tx.create(receipt,{version:1,companyId:p.companyId,driverId:p.driverId,eventId:e.id,eventHash,recordId,confirmedAtMs:Date.now()});
  return {version:1,state:'confirmed',eventId:e.id,eventHash,recordId};
 });}catch(error){if(error instanceof https.HttpsError)throw error;
  const code=(error as any)?.code;if([4,8,10,13,14,'deadline-exceeded','resource-exhausted','aborted','internal','unavailable'].includes(code))throw new https.HttpsError('unavailable','JSA delivery is deferred; the update remains saved on this phone.');
  const reason=error instanceof Error?error.message:'commit_failed';
  console.warn('WB_JSA_OFFLINE_COMMIT',{reason:/^[a-z_]{1,50}$/.test(reason)?reason:'store_error'});
  throw new https.HttpsError('failed-precondition','Offline JSA update needs review.',{reason:/^[a-z_]{1,50}$/.test(reason)?reason:'store_error'});
 }
});
