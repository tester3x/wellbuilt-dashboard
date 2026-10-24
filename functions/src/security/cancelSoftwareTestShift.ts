import * as admin from 'firebase-admin';
import {FieldValue} from 'firebase-admin/firestore';
import {HttpsError,onCall} from 'firebase-functions/v2/https';
import {loadCanonicalDriverAuthority,productionCanonicalDriverReaders} from './canonicalDriverAuthority';

const time = (v:any):number => typeof v?.toMillis==='function'?v.toMillis():v instanceof Date?v.getTime():Date.parse(v);
const fail = (reason:string):never => {throw new HttpsError('failed-precondition',reason);};
/** A protected, operator-issued exact-session authorization is mandatory.
 * This does not relax ordinary shift cancellation or any inspection gate. */
export const cancelAuthorizedSoftwareTestShift=onCall({timeoutSeconds:30,enforceAppCheck:false},async request=>{
  const c=request.auth?.token,d=request.data;
  if(!request.auth?.uid||c?.kind!=='driver'||typeof c.driverId!=='string')throw new HttpsError('unauthenticated','driver_required');
  if(c.app!=null&&c.app!=='wbs')throw new HttpsError('permission-denied','suite_required');
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['periodId','reason','noActualWork'].includes(k))
    ||!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d.periodId||'')||typeof d.reason!=='string'
    ||d.reason.trim().length<8||d.reason.length>240||d.noActualWork!==true)throw new HttpsError('invalid-argument','invalid_test_cancellation');
  const who=await loadCanonicalDriverAuthority(c.driverId,productionCanonicalDriverReaders());
  if(!who?.active||who.companyId!==c.companyId)throw new HttpsError('permission-denied','driver_scope_changed');
  const db=admin.firestore(),period=d.periodId;
  const credential=db.doc(`driver_credentials/${who.driverId}`),authority=db.doc(`driver_shift_authority/${who.driverId}`);
  const day=db.doc(`driver_shifts/${who.driverId}_${period.slice(0,10)}`);
  const ledger=db.doc(`driver_dvir_completions/${who.driverId}/shifts/${period}`);
  const audit=db.doc(`driver_shift_cancellations/${who.driverId}/shifts/${period}`);
  const owned=(r:any)=>r?.driverId===who.driverId&&r?.companyId===who.companyId;
  return db.runTransaction(async tx=>{
    const [credSnap,authoritySnap,daySnap,ledgerSnap,auditSnap]=await Promise.all([tx.get(credential),tx.get(authority),tx.get(day),tx.get(ledger),tx.get(audit)]);
    if(auditSnap.exists){if(!owned(auditSnap.data())||auditSnap.data()?.periodId!==period)fail('test_audit_owner_mismatch');return {protocolVersion:1,cancelledPeriodId:period,alreadyCancelled:true};}
    const cred=credSnap.data(),a=authoritySnap.data()||{},daily=daySnap.data()||{},inspection=ledgerSnap.data();
    const grant=cred?.softwareTestCleanup;
    if(cred?.active===false||!grant||grant.purpose!=='offline_app_acceptance'||!owned(grant)
      ||grant.periodId!==period||typeof grant.issuedBy!=='string'||!grant.issuedBy||grant.consumedAt
      ||!Number.isFinite(time(grant.expiresAt))||time(grant.expiresAt)<=Date.now()
      ||!Array.isArray(grant.invoiceIds)||grant.invoiceIds.length<1||grant.invoiceIds.length>20
      ||new Set(grant.invoiceIds).size!==grant.invoiceIds.length)fail('software_test_authorization_required');
    if(!owned(a)||!owned(daily)||a.initialized!==true||a.openPeriodId!==period||daily.currentShiftId!==period
      ||!Number.isInteger(a.version))fail('test_shift_not_current');
    if(inspection&&(!owned(inspection)||inspection.shiftId!==period||inspection.preTrip||inspection.postTrip
      ||inspection.postTripPending||inspection.postTripStarted))fail('inspection_already_recorded');
    if(!Array.isArray(daily.events)||daily.events.some((e:any)=>!e?.shiftId))fail('ambiguous_shift_history');
    const original=daily.events.filter((e:any)=>e.shiftId===period);
    if(original.length!==1||original[0].type!=='login'||original[0].source!=='server'||!Number.isFinite(time(original[0].timestamp)))fail('test_shift_has_other_activity');
    const all=await tx.get(db.collection('invoices').where('driverId','==',who.driverId).limit(101));
    if(all.size>=101)fail('test_history_requires_review');
    if(all.docs.some(s=>!Number.isFinite(time(s.data().createdAt))
      && !['closed','cancelled','canceled','void','voided'].includes(String(s.data().status))))fail('ambiguous_test_jobs');
    const current=all.docs.filter(s=>time(s.data().createdAt)>=time(original[0].timestamp));
    if(current.length!==grant.invoiceIds.length||current.some(s=>!grant.invoiceIds.includes(s.id)))fail('unexpected_test_jobs');
    for(const s of current){
      const invoice=s.data();
      // Additional software-only pickups require a protected exact fixture.
      // Driver-supplied cancellation requests cannot broaden this authorization.
      const proof=Array.isArray(grant.invoiceProofs)?grant.invoiceProofs.find((p:any)=>p.invoiceId===s.id):null;
      const testWell=proof?.wellName||'Test Well';
      if(typeof testWell!=='string'||!testWell.trim()||!owned(invoice)||invoice.status!=='closed'||invoice.wellName!==testWell||invoice.operator!=='WB Test Customer'
        ||Number(invoice.totalBBL)!==1)fail('non_test_work_found');
      const tickets=await tx.get(db.collection('tickets').where('invoiceDocId','==',s.id).limit(3));
      if(tickets.size!==1||tickets.docs.some(t=>{const r=t.data();return !owned(r)||r.invoiceDocId!==s.id
        ||r.wellName!==testWell||r.operator!=='WB Test Customer'||!/^SOFTWARE_TEST_ONLY_/.test(String(r.notes||''))
        ||proof&&String(r.ticketNumber)!==String(proof.ticketNumber);}))fail('test_ticket_proof_required');
    }
    const at=new Date().toISOString();
    tx.create(audit,{driverId:who.driverId,companyId:who.companyId,periodId:period,reason:d.reason.trim(),
      source:'authorized_software_test_cancellation',softwareTest:true,noWorkPerformed:true,
      actorUid:request.auth!.uid,authorization:grant,
      originalEvents:original,originalAuthorityVersion:a.version,invoiceIds:grant.invoiceIds,cancelledAt:at,
      createdAt:FieldValue.serverTimestamp()});
    tx.update(authority,{openPeriodId:null,originLocalDate:null,lastClosedPeriodId:period,version:a.version+1,updatedAt:FieldValue.serverTimestamp()});
    tx.update(day,{currentShiftId:'',events:[...daily.events.filter((e:any)=>e.shiftId!==period),
      {type:'shift_cancelled',timestamp:at,shiftId:period,source:'authorized_software_test',startedAt:original[0].timestamp,
        reason:d.reason.trim(),softwareTest:true,noActualWork:true}],updatedAt:FieldValue.serverTimestamp()});
    tx.update(credential,{'softwareTestCleanup.consumedAt':at});
    return {protocolVersion:1,cancelledPeriodId:period,alreadyCancelled:false};
  });
});
