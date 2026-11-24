import {createHash} from 'crypto';
import {parseAuthPrincipal, type AuthPrincipal} from './jsaReceiptCore';
export class EvidenceError extends Error {
  constructor(readonly code:'unauthenticated'|'permission-denied'|'invalid-argument'|'failed-precondition',message:string){super(message);}
}
type Row=Record<string,unknown>;
export interface EvidenceStore {
  transaction<T>(work:(tx:{get(path:string):Promise<Row|null>;create(path:string,row:Row):void})=>Promise<T>):Promise<T>;
  list(companyId:string,driverId:string,after:string|null):Promise<Row[]>;
}
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
function deny(reason:string):never{throw new EvidenceError('permission-denied',reason);}
function bad():never{throw new EvidenceError('invalid-argument','malformed');}
const text=(v:unknown,max=128):string=>{if(typeof v!=='string'||!v||v!==v.trim()||v.length>max||/[\x00-\x1f/]/.test(v))return bad();return v;};
export function evidenceCanonical(v:unknown,depth=0):string {
  if(depth>32)bad();
  if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(x=>evidenceCanonical(x,depth+1)).join(',')+']';
  if(object(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+evidenceCanonical(v[k],depth+1)).join(',')+'}';
  return bad();
}
const digest=(v:unknown)=>createHash('sha256').update(evidenceCanonical(v)).digest('hex');
function owned(p:AuthPrincipal,r:Row){if(r.companyId!==p.companyId||(r.driverId||r.driverHash)!==p.driverId||r.driverHash&&r.driverHash!==p.driverId)deny('owner_mismatch');}
function signedRecord(p:AuthPrincipal,r:Row){
 owned(p,r);text(r.id);if(typeof r.timestamp!=='string'||!Number.isFinite(Date.parse(r.timestamp)))bad();
 if(!(typeof r.signature==='string'&&r.signature.trim())&&!(typeof r.signatureImage==='string'&&r.signatureImage.length))bad();
 if(r.governedRequestRef||r.workflow==='prepared'||r.workflow==='standalone')deny('use_governed_evidence_path');
 if(Buffer.byteLength(evidenceCanonical(r),'utf8')>500000)bad();
}
/** Historical evidence only. Does not replace or satisfy governed JSA requests. */
export async function handleLegacyEvidence(store:EvidenceStore,auth:{uid?:string|null;claims?:Row|null},raw:unknown,membership:(p:AuthPrincipal)=>Promise<boolean>,now:number):Promise<Row>{
 const parsed=parseAuthPrincipal(auth);if(!parsed.ok)throw new EvidenceError(auth.uid?'permission-denied':'unauthenticated','authentication');
 const p=parsed.value;if(!object(raw))bad();const op=raw.operation;
 if(p.app!=='jsa'&&!(p.app==='wbt'&&op==='get_receipt'))deny('audience');
 if(!await membership(p))deny('membership');
 if(op==='list'){
  if(Object.keys(raw).some(k=>!['operation','after'].includes(k)))bad();
  const after=raw.after===undefined||raw.after===null?null:text(raw.after);
  const records=await store.list(p.companyId,p.driverId,after);records.forEach(r=>owned(p,r));
  return {schemaVersion:1,companyId:p.companyId,driverId:p.driverId,records};
 }
 if(op==='store'){
  if(Object.keys(raw).some(k=>!['operation','record'].includes(k))||!object(raw.record))bad();
  const record=raw.record;signedRecord(p,record);const id=text(record.id),hash=digest(record);
  return store.transaction(async tx=>{
   const old=await tx.get('jsas/'+id),metaPath='jsa_legacy_evidence/'+digest([p.companyId,p.driverId,id]),meta=await tx.get(metaPath);
   if(old){owned(p,old);if(digest(old)!==hash)throw new EvidenceError('failed-precondition','immutable_evidence_conflict');}
   if(meta&&(meta.companyId!==p.companyId||meta.driverId!==p.driverId||meta.recordId!==id||meta.snapshotHash!==hash))deny('evidence_binding');
   if(!old)tx.create('jsas/'+id,record);
   if(!meta)tx.create(metaPath,{schemaVersion:1,companyId:p.companyId,driverId:p.driverId,recordId:id,snapshotHash:hash,archivedByUid:p.uid,archivedAtMs:now});
   return {schemaVersion:1,companyId:p.companyId,driverId:p.driverId,recordId:id,snapshotHash:hash,reused:!!old};
  });
 }
 if(op==='receipt'||op==='get_receipt'){
  if(Object.keys(raw).some(k=>!['operation','requestId','recordId'].includes(k)))bad();
  const requestId=text(raw.requestId);if(!/^[A-Za-z0-9_-]{43}$/.test(requestId))bad();
  return store.transaction(async tx=>{
   const path='jsa_read_receipts/'+requestId,prior=await tx.get(path),proofPath='jsa_authenticated_receipts/'+requestId,proof=await tx.get(proofPath);
   if(op==='get_receipt'){
    if(!prior)return {schemaVersion:1,receipt:null};owned(p,prior);
    if(!proof||proof.receiptHash!==digest(prior))return {schemaVersion:1,receipt:null};owned(p,proof);
    const saved=await tx.get('jsas/'+text(prior.jsaRecordId));if(!saved)return {schemaVersion:1,receipt:null};owned(p,saved);
    if(proof.snapshotHash!==digest(saved))deny('immutable_evidence_conflict');
    return {schemaVersion:1,receipt:prior};
   }
   const recordId=text(raw.recordId),record=await tx.get('jsas/'+recordId);if(!record)throw new EvidenceError('failed-precondition','evidence_pending');
   signedRecord(p,record);
   const meta=await tx.get('jsa_legacy_evidence/'+digest([p.companyId,p.driverId,recordId]));
   if(!meta||meta.snapshotHash!==digest(record))throw new EvidenceError('failed-precondition','evidence_not_verified');
   const b=record.legacyReceiptBinding;if(!object(b)||b.requestId!==requestId||b.companyId!==p.companyId||b.driverHash!==p.driverId)deny('receipt_binding');
   const signedAt=Date.parse(String(record.timestamp)),receivedAt=Date.parse(String(b.receivedAt)),expiresAt=Date.parse(String(b.expiresAt));
   if(!Number.isFinite(receivedAt)||!Number.isFinite(expiresAt)||signedAt<receivedAt||signedAt>expiresAt||signedAt>now+300000)deny('signed_request_time');
   const jobId=text(b.jobDocId),job=await tx.get('invoices/'+jobId);if(!job)deny('job_missing');owned(p,job);
   const version=b.receiptVersion;if(version!==1&&version!==2)bad();
   if(version===1){if(!b.shiftId||record.shiftId!==b.shiftId||job.shiftId!==b.shiftId)deny('shift_unverified');}
   else {
    if(!['explicit_shift','company_defined_period'].includes(String(b.workPeriodMode)))bad();
    const period=await tx.get('jsa_work_periods/'+text(b.periodId));if(!period)deny('period_unverified');owned(p,period);
    const signedAt=Date.parse(String(record.timestamp));
    if(!Number.isFinite(period.createdAtMs)||signedAt<Number(period.createdAtMs)||period.finalizedAtMs&&signedAt>Number(period.finalizedAtMs))deny('period_time');
    if(job.jsaPeriodId!==b.periodId)deny('job_period_unverified');
   }
   const receipt:Row={receiptVersion:version,requestId,jobDocId:jobId,companyId:p.companyId,driverHash:p.driverId,operator:record.operator||'',jsaRecordId:recordId,completedAt:record.timestamp,completionType:'signed_submission',...(b.haulGroupId?{haulGroupId:b.haulGroupId}:{})};
   if(version===1)receipt.shiftId=b.shiftId;
   else Object.assign(receipt,{requestPeriodId:b.periodId,submissionPeriodId:b.periodId,workPeriodMode:b.workPeriodMode});
   if(prior){owned(p,prior);if(evidenceCanonical(prior)!==evidenceCanonical(receipt))throw new EvidenceError('failed-precondition','immutable_receipt_conflict');}
   else tx.create(path,receipt);
   const receiptProof={companyId:p.companyId,driverId:p.driverId,recordId,receiptHash:digest(receipt),snapshotHash:digest(record)};
   if(proof&&evidenceCanonical(proof)!==evidenceCanonical(receiptProof))deny('receipt_proof_conflict');
   if(!proof)tx.create(proofPath,receiptProof);
   return {schemaVersion:1,receipt,reused:!!prior};
  });
 }
 return bad();
}
