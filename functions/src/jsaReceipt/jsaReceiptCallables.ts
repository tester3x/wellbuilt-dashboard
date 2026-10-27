import {signedReadJsaNumber} from './jsaNumber';
/**
 * Thin callable wrappers. Auth identity from request.auth only.
 */
import {JSA_JOB_ACK_COLLECTION} from '@tester3x/wellbuilt-contracts';
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash, randomBytes } from 'crypto';
import {resolveJsaWorkPeriod} from './jsaWorkPeriodStore';
import {resolveJobDayPolicy as resolveLegacyJobDayPolicy} from './jsaLegacyJobDayPolicy';
import {createLegacyJobDayCallables} from './jsaLegacyJobDayCallables';
import { checkRateLimit } from '../security/rateLimit';
import { decideResolve } from '../security/operational/shiftAuthority.js';
import { shiftAuthorityPath, type ShiftAuthorityRecord } from '../security/operational/shiftAuthority.js';
import { buildSsoDeps } from '../sso/ssoCallables.js';
import {
  JsaReceiptError,
  handleComplete,
  handleConsume,
  handleGetContext,
  handlePersistArtifact,
  handleRegister,
  type ReceiptDeps,
  type ReceiptTxn,
} from './jsaReceiptHandlers.js';
import { handleResolveCurrentShiftReadEvidence } from './jsaCurrentShiftReadEvidence.js';
import { handleAcknowledgeJob } from './jsaJobAcknowledgment.js';
import {hasHistoricalJobCoverage,companyJsaDay,jobDayPrincipal,resolveJobDayPolicy,type JobDayDeps} from './jsaJobDayPolicy';
import {decideInvoiceJobFields,parseRegisterInput} from './jsaReceiptCore';
import { fromStored } from './jsaReceiptCore.js';

const OPTIONS = {
  timeoutSeconds: 30,
  memory: '256MiB' as const,
  enforceAppCheck: false,
};

function toHttps(err: unknown): httpsV2.HttpsError {
  if (err instanceof JsaReceiptError) {
    return new httpsV2.HttpsError(err.http, err.refusal, { reason: err.refusal });
  }
  return new httpsV2.HttpsError('internal', 'unavailable');
}

function authOf(request: httpsV2.CallableRequest) {
  return {
    uid: request.auth?.uid ?? null,
    claims: (request.auth?.token || {}) as Record<string, unknown>,
  };
}

export function buildReceiptDeps(useShiftContext=false): ReceiptDeps {
  const db = admin.firestore();
  // CANONICAL POLICY READERS — the very same functions SSO issuance uses,
  // taken from its production deps builder rather than re-implemented, so
  // registration and issuance literally share one contract parser and one
  // plan reader and cannot drift.
  const sso = buildSsoDeps();
  return {
    readRequest: async requestId => fromStored((await db.collection('jsa_governed_requests').doc(requestId).get()).data()),
    jobDayBinding: (p,day,contextId) => useShiftContext||contextId ? resolveJobDayPolicy(jobDayDeps(),p,day) : resolveLegacyJobDayPolicy(legacyJobDayDeps(),p,day),
    nowMs: () => Date.now(),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    base64Url: (b) => Buffer.from(b).toString('base64url'),
    getCompanyContract: (companyId) => sso.getCompanyContract(companyId),
    getPlan: (planId) => sso.getPlan(planId),
    async getJsaStylePolicy(companyId) {
      // Completion style only. Same mapping as Dashboard canonicalizeJsaJobPolicy:
      // an explicit jsaJobPolicy wins; otherwise jsaAllowAcknowledge === false
      // means read, and an absent field means acknowledge. Acknowledge still
      // allows a full read because that subrule's first job is a full JSA.
      // A read failure offers no acknowledge shortcut. This cannot enable JSA.
      try {
        const snap = await db.collection('companies').doc(companyId).get();
        const d = snap.data() || {};
        const explicit = d.jsaJobPolicy;
        const policy = explicit === 'acknowledge' || explicit === 'read' || explicit === 'read_and_acknowledge'
          ? explicit
          : (d.jsaAllowAcknowledge === false ? 'read' : 'acknowledge');
        if (policy === 'read') return { allowRead: true, allowAcknowledge: false };
        return { allowRead: true, allowAcknowledge: true };
      } catch {
        return { allowRead: true, allowAcknowledge: false };
      }
    },
    async readInvoice(jobRef) {
      const snap = await db.collection('invoices').doc(jobRef).get();
      return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
    },
    async resolveShift(driverId, companyId) {
      try {
        const snap = await db.doc(shiftAuthorityPath(driverId)).get();
        if (!snap.exists) return decideResolve(null, { driverId, companyId });
        const d = snap.data() ?? {};
        if (typeof d.driverId !== 'string' || typeof d.companyId !== 'string'
          || typeof d.initialized !== 'boolean' || typeof d.version !== 'number') {
          return decideResolve(null, { driverId, companyId });
        }
        const rec: ShiftAuthorityRecord = {
          driverId: d.driverId,
          companyId: d.companyId,
          initialized: d.initialized,
          openPeriodId: typeof d.openPeriodId === 'string' ? d.openPeriodId : null,
          originLocalDate: typeof d.originLocalDate === 'string' ? d.originLocalDate : null,
          version: d.version,
        };
        return decideResolve(rec, { driverId, companyId });
      } catch {
        return decideResolve(null, { driverId, companyId });
      }
    },
    async runTransaction(fn) {
      return db.runTransaction(async (t) => {
        const txn: ReceiptTxn = {
          async get(path) {
            const s = await t.get(db.doc(path));
            return { exists: s.exists, data: s.data() as Record<string, unknown> | undefined };
          },
          create(path, data) { t.create(db.doc(path), data); },
          update(path, fields) { t.update(db.doc(path), fields); },
        };
        return fn(txn);
      });
    },
    log(event, extra) {
      // Bounded reason codes only — never identifiers.
      console.log(JSON.stringify({ tag: event, ...extra }));
    },
  };
}

async function limited(uid: string, bucket: string): Promise<void> {
  const allowed = await checkRateLimit({
    bucket,
    key: uid,
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
  if (!allowed) throw new httpsV2.HttpsError('resource-exhausted', 'unavailable');
}

export const jsaRegisterReadRequest = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_register');
  try { return await handleRegister(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaGetReadRequest = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  // Higher window than the mutating callables: a crash/resume loop may
  // legitimately re-read several times, and the operation writes nothing.
  const allowed = await checkRateLimit({
    bucket: 'jsa_get',
    key: request.auth.uid,
    limit: 60,
    windowMs: 10 * 60 * 1000,
  });
  if (!allowed) throw new httpsV2.HttpsError('resource-exhausted', 'unavailable');
  try { return await handleGetContext(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaCompleteReadRequest = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_complete');
  try { return await handleComplete(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaPersistGovernedArtifact = httpsV2.onCall({ ...OPTIONS, memory: '512MiB' }, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_artifact');
  try { return await handlePersistArtifact(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaConsumeReadResult = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_consume');
  try { return await handleConsume(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

function currentShiftReadEvidenceDeps() {
  const db = admin.firestore();
  const base = buildReceiptDeps();
  return {
    resolveShift: (driverId: string, companyId: string) => base.resolveShift(driverId, companyId),
    async listGovernedByPeriod(companyId: string, driverId: string, periodId: string) {
      const snap = await db.collection('jsa_governed_requests')
        .where('companyId', '==', companyId)
        .where('driverId', '==', driverId)
        .where('binding.periodId', '==', periodId)
        .get();
      const out = [];
      for (const doc of snap.docs) {
        const rec = fromStored(doc.data());
        if (!rec) continue;
        out.push({
          companyId: rec.companyId,
          driverId: rec.driverId,
          state: rec.state,
          action: rec.action,
          bindingPeriodId: rec.binding.periodId ?? null,
        });
      }
      return out;
    },
    log: base.log,
  };
}

export const jsaResolveCurrentShiftReadEvidence = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_shift_read_evidence');
  try {
    return await handleResolveCurrentShiftReadEvidence(
      currentShiftReadEvidenceDeps(),
      authOf(request),
      request.data,
    );
  } catch (err) { throw toHttps(err); }
});

function jobAckDeps() {
  const db = admin.firestore();
  const base = currentShiftReadEvidenceDeps();
  return {
    nowMs: () => Date.now(),
    sha256Hex(input: string) {
      return createHash('sha256').update(input, 'utf8').digest('hex');
    },
    resolveShift: base.resolveShift,
    async readAuthority(driverId: string) {
      const snap = await db.doc(shiftAuthorityPath(driverId)).get();
      if (!snap.exists) return null;
      const d = snap.data() ?? {};
      if (typeof d.driverId !== 'string' || typeof d.companyId !== 'string'
        || typeof d.initialized !== 'boolean' || typeof d.version !== 'number') {
        return null;
      }
      return {
        driverId: d.driverId,
        companyId: d.companyId,
        initialized: d.initialized,
        openPeriodId: typeof d.openPeriodId === 'string' ? d.openPeriodId : null,
        originLocalDate: typeof d.originLocalDate === 'string' ? d.originLocalDate : null,
        version: d.version,
        lastClosedPeriodId: typeof d.lastClosedPeriodId === 'string' ? d.lastClosedPeriodId : null,
      };
    },
    async readShiftDay(driverId: string, localDate: string) {
      const snap = await db.doc(`driver_shifts/${driverId}_${localDate}`).get();
      if (!snap.exists) return null;
      const d = snap.data() ?? {};
      const raw = Array.isArray(d.events) ? d.events : [];
      const events = [];
      for (const ev of raw) {
        if (!ev || typeof ev !== 'object') continue;
        const e = ev as Record<string, unknown>;
        if (typeof e.type !== 'string' || typeof e.shiftId !== 'string'
          || typeof e.timestamp !== 'string' || typeof e.source !== 'string') {
          continue;
        }
        events.push({
          type: e.type,
          shiftId: e.shiftId,
          timestamp: e.timestamp,
          source: e.source,
        });
      }
      return {
        date: typeof d.date === 'string' ? d.date : localDate,
        currentShiftId: typeof d.currentShiftId === 'string' ? d.currentShiftId : null,
        events,
      };
    },
    async readInvoice(jobRef: string) {
      const snap = await db.collection('invoices').doc(jobRef).get();
      return {
        exists: snap.exists,
        createTimeMs: snap.createTime ? snap.createTime.toMillis() : null,
        data: snap.exists ? (snap.data() as Record<string, unknown>) : null,
      };
    },
    async readDispatch(dispatchId: string) {
      const snap = await db.collection('dispatches').doc(dispatchId).get();
      return {
        exists: snap.exists,
        data: snap.exists ? (snap.data() as Record<string, unknown>) : null,
      };
    },
    listGovernedByPeriod: base.listGovernedByPeriod,
    async runTransaction<T>(fn: (txn: {
      get(path: string): Promise<{ exists: boolean; data?: Record<string, unknown> }>;
      create(path: string, data: Record<string, unknown>): void;
    }) => Promise<T>): Promise<T> {
      return db.runTransaction(async (t) => {
        const txn = {
          async get(path: string) {
            const s = await t.get(db.doc(path));
            return { exists: s.exists, data: s.data() as Record<string, unknown> | undefined };
          },
          create(path: string, data: Record<string, unknown>) { t.create(db.doc(path), data); },
        };
        return fn(txn);
      });
    },
    log: base.log,
  };
}

export const jsaAcknowledgeJob = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_job_ack');
  try {
    return await handleAcknowledgeJob(jobAckDeps(), authOf(request), request.data);
  } catch (err) { throw toHttps(err); }
});

// New job-day clients use a distinct registration endpoint. Legacy shift requests
// keep their existing records and validators; completion discovers stored scope.
function jobDayDeps():JobDayDeps {
 const db=admin.firestore();return {shift:(d,c)=>buildReceiptDeps().resolveShift(d,c),sso:buildSsoDeps(),nowMs:()=>Date.now(),
  company:async id=>(await db.collection('companies').doc(id).get()).data()||{},
  workPeriod:(p,day)=>resolveJsaWorkPeriod(p.companyId,p.driverId,day),
  records:async(company,driver,day,period)=>{
   const snap=await db.collection('jsa_governed_requests').where('companyId','==',company).where('driverId','==',driver).where(period?'binding.jsaPeriodId':'binding.policyDay','==',period||day).get();
   return snap.docs.map(d=>fromStored(d.data())).filter((r):r is NonNullable<typeof r>=>!!r);
  }};
}
function legacyJobDayDeps():JobDayDeps {
 const deps=jobDayDeps();delete deps.workPeriod;
 deps.records=async(company,driver,day,period)=>{
  const rows=await admin.firestore().collection('jsa_governed_requests').where('companyId','==',company).where('driverId','==',driver).where(period?'binding.associatedPeriodId':'binding.policyDay','==',period||day).get();
  return rows.docs.map(d=>fromStored(d.data())).filter((r):r is NonNullable<typeof r>=>!!r&&!r.binding.jsaPeriodId);
 };return deps;
}
async function ownedJob(p:ReturnType<typeof jobDayPrincipal>,jobRef:string,allowMissing=false){
 const invoice=await buildReceiptDeps().readInvoice(jobRef);
 if(!invoice.exists&&allowMissing)return false;
 const fields=decideInvoiceJobFields({expectedCompanyId:p.companyId,expectedDriverId:p.driverId,invoice:{exists:invoice.exists,...invoice.data}});
 if(!fields.ok)throw new JsaReceiptError('permission-denied','not_owner','job');return invoice.data!;
}
function jobStopSnapshot(job:Record<string,unknown>|false){
 if(!job)return null;
 const text=(v:unknown)=>typeof v==='string'?v.slice(0,300):'';
 return {wellName:text(job.wellName),operator:text(job.operator),jobType:text(job.commodityType||job.jobType),dropOff:text(job.hauledTo||job.disposalName||job.dropOff)};
}
function jobDayRequest(data:unknown):{jobRef:string} {
 const d=data as Record<string,unknown>;
 if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['protocolVersion','jobRef','purpose'].includes(k))||d.protocolVersion!==1||(d.purpose!==undefined&&!['start','coverage'].includes(String(d.purpose)))||typeof d.jobRef!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(d.jobRef))throw new JsaReceiptError('invalid-argument','malformed','request');
 return {jobRef:d.jobRef};
}
const jobDayAckPath=(company:string,driver:string,job:string,day:string)=>JSA_JOB_ACK_COLLECTION+'/'+createHash('sha256').update(JSON.stringify(['job-day',company,driver,job,day])).digest('hex');
export const jsaRegisterJobShiftReadRequest=httpsV2.onCall(OPTIONS,async request=>{
 if(!request.auth?.uid)throw new httpsV2.HttpsError('unauthenticated','not_authorized');
 await limited(request.auth.uid,'jsa_register_job_day');
 try{
  const deps=buildReceiptDeps(true),parsed=parseRegisterInput(request.data);
  if(parsed.ok){
   const p=jobDayPrincipal(authOf(request)),old=await deps.readRequest!(parsed.value.requestId);
   if(old&&old.companyId===p.companyId&&old.driverId===p.driverId&&old.binding.shiftState==='independent'){
    const current=await resolveJobDayPolicy(jobDayDeps(),p);
    if(old.binding.jsaPeriodId!==current.binding.jsaPeriodId || old.binding.policyDay!==current.binding.policyDay)throw new JsaReceiptError('failed-precondition','expired','workday_changed');
   }
  }
  const result=await handleRegister({...deps,registerJobDay:true},authOf(request),request.data);
  const stored=await deps.readRequest!(result.requestId);
  return {...result,policyDay:stored?.binding.policyDay};
 }catch(e){throw toHttps(e);}
});
export const jsaResolveJobShiftEvidence=httpsV2.onCall(OPTIONS,async request=>{
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
   const coverageRows=await db.collection('jsa_job_read_coverage').where('companyId','==',p.companyId).where('driverId','==',p.driverId).where('jobRef','==',jobRef).limit(100).get();
   const linkedCoverage=coverageRows.docs.map(d=>d.data()).find(r=>r.method==='scope_read');
   const historical=jobExists&&hasHistoricalJobCoverage(p,jobRef,reads.docs.map(d=>fromStored(d.data())).filter((r):r is NonNullable<typeof r>=>!!r),acknowledgements.docs.map(d=>d.data()),linkedCoverage||null);
   return {protocolVersion:1,policy: {mode:scope.mode},historicalJobSatisfied:historical};
  }

  const rows=scope.rows;
  const ack=(await admin.firestore().doc(jobDayAckPath(p.companyId,p.driverId,jobRef,scope.requirementKey)).get()).data();
  const full=rows.some(r=>r.jobRef===jobRef&&r.state==='completed'&&(r.action==='read_and_acknowledged'||!scope.binding.jsaPeriodId&&scope.style!=='read_and_acknowledge'&&r.action==='read_completed'));
  const ackOk=scope.policy.allowAcknowledge&&ack?.companyId===p.companyId&&ack?.driverId===p.driverId&&ack?.jobRef===jobRef&&ack?.policyDay===day&&ack?.method==='acknowledged';
  return {protocolVersion:1,policyDay:day,requirementKey:scope.requirementKey,readJobRef:rows.find(r=>r.state==='completed'&&r.action==='read_and_acknowledged')?.jobRef||null,hasRead:scope.hasRead,jobSatisfied:jobExists&&(full||ackOk),policy:{mode:scope.mode,allowAcknowledge:true,intent:'read_and_acknowledge'}};
 }catch(e){throw toHttps(e);}
});
export const jsaAcknowledgeJobShift=httpsV2.onCall(OPTIONS,async request=>{
 if(!request.auth?.uid)throw new httpsV2.HttpsError('unauthenticated','not_authorized');
 await limited(request.auth.uid,'jsa_ack_job_day');
 try{
  const {jobRef}=jobDayRequest(request.data),p=jobDayPrincipal(authOf(request)),job=await ownedJob(p,jobRef);
  const scope=await resolveJobDayPolicy(jobDayDeps(),p);
  if(!scope.policy.allowAcknowledge)throw new JsaReceiptError('failed-precondition','no_qualifying_read','full_read_required');
  const day=scope.binding.policyDay!,ref=admin.firestore().doc(jobDayAckPath(p.companyId,p.driverId,jobRef,scope.requirementKey));
  const state=await admin.firestore().runTransaction(async tx=>{
   const old=(await tx.get(ref)).data();
   if(old){if(old.companyId!==p.companyId||old.driverId!==p.driverId||old.jobRef!==jobRef||old.policyDay!==day||old.method!=='acknowledged')throw new JsaReceiptError('failed-precondition','binding_mismatch','ack');return 'already_recorded';}
   const firstRead=scope.rows.filter(r=>r.state==='completed'&&(r.action==='read_and_acknowledged'||!scope.binding.jsaPeriodId&&scope.style!=='read_and_acknowledge'&&r.action==='read_completed')).sort((a,b)=>(a.completedAtMs||0)-(b.completedAtMs||0)||a.requestId.localeCompare(b.requestId))[0];
   if(!firstRead)throw new JsaReceiptError('failed-precondition','no_qualifying_read','full_read_required');
   tx.create(ref,{job:jobStopSnapshot(job),jsaNumber:signedReadJsaNumber(firstRead),requirementKey:scope.requirementKey,fullReadId:firstRead.requestId,schemaVersion:1,companyId:p.companyId,driverId:p.driverId,jobRef,policyDay:day,periodId:scope.binding.associatedPeriodId||null,method:'acknowledged',recordedAtMs:Date.now()});return 'recorded';
  });return {protocolVersion:1,state,policyDay:day};
 }catch(e){throw toHttps(e);}
});

/** Link a once-per-scope full read to a particular job without inventing a
 * per-job acknowledgement or asking the driver for another ceremony. */
export const jsaRecordJobShiftReadCoverage=httpsV2.onCall(OPTIONS,async request=>{
 if(!request.auth?.uid)throw new httpsV2.HttpsError('unauthenticated','not_authorized');
 await limited(request.auth.uid,'jsa_scope_read_coverage');
 try{
  const {jobRef}=jobDayRequest(request.data),p=jobDayPrincipal(authOf(request)),job=await ownedJob(p,jobRef);
  const scope=await resolveJobDayPolicy(jobDayDeps(),p);
  if(scope.mode!=='per_shift'||!scope.hasRead)throw new JsaReceiptError('failed-precondition','no_qualifying_read','scope_read_required');
  const first=scope.rows.filter(r=>r.companyId===p.companyId&&r.driverId===p.driverId&&r.state==='completed'&&(r.action==='read_and_acknowledged'||!scope.binding.jsaPeriodId&&scope.style!=='read_and_acknowledge'&&r.action==='read_completed')).sort((a,b)=>(a.completedAtMs||0)-(b.completedAtMs||0))[0];
  if(!first)throw new JsaReceiptError('failed-precondition','no_qualifying_read','scope_read_required');
  const recordId=createHash('sha256').update(JSON.stringify([p.companyId,p.driverId,jobRef,scope.requirementKey])).digest('hex'),ref=admin.firestore().doc('jsa_job_read_coverage/'+recordId);
  await admin.firestore().runTransaction(async tx=>{const prior=(await tx.get(ref)).data();if(prior){if(prior.companyId!==p.companyId||prior.driverId!==p.driverId||prior.jobRef!==jobRef||prior.method!=='scope_read')throw new JsaReceiptError('failed-precondition','binding_mismatch','coverage');return;}tx.create(ref,{job:jobStopSnapshot(job),schemaVersion:1,companyId:p.companyId,driverId:p.driverId,jobRef,method:'scope_read',fullReadId:first.requestId,requirementKey:scope.requirementKey,policyDay:scope.binding.policyDay,periodId:scope.binding.associatedPeriodId||null,recordedAtMs:Date.now()});});
  return {protocolVersion:1,state:'recorded',recordId};
 }catch(e){throw toHttps(e);}
});

// Preserve the deployed protocol for installed clients until their APK update.
const legacyJobDayCallables=createLegacyJobDayCallables({buildReceiptDeps:()=>buildReceiptDeps(false),limited,authOf,toHttps});
export const {jsaRegisterJobReadRequest,jsaResolveJobReadEvidence,jsaAcknowledgeJobDay,jsaRecordJobReadCoverage}=legacyJobDayCallables;
