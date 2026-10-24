import * as admin from 'firebase-admin';
import {offlineHash,type OfflineEvent,type OfflineGrant} from './jsaOfflineCore';

export function offlineLocationProjection(owner:{driverId:string;companyId:string}, event:OfflineEvent,
 grant:OfflineGrant, receipt:any, job:any, existing:any) {
 if(grant?.driverId!==owner.driverId||grant.companyId!==owner.companyId
  ||receipt?.driverId!==owner.driverId||receipt.companyId!==owner.companyId
  ||receipt.eventId!==event.id||receipt.eventHash!==offlineHash(event)
  ||job?.companyId!==owner.companyId||(job.driverId||job.driverHash)!==owner.driverId
  ||!grant.shiftId)throw Error('location_projection_identity');
 if(existing&&(existing.companyId!==owner.companyId||(existing.driverId||existing.driverHash)!==owner.driverId))throw Error('location_projection_owner');
 const wells:any[]=[],seen=new Set<string>();
 for(const value of [...(Array.isArray(existing?.wells)?existing.wells:[]),...(Array.isArray(existing?.locations)?existing.locations:[])]) {
  const w=typeof value==='string'?{name:value}:value;
  if(typeof w?.name!=='string'||!w.name.trim()||seen.has(w.name.trim().toUpperCase()))continue;
  seen.add(w.name.trim().toUpperCase());wells.push(w);
 }
 for(const [name,type] of [[job.wellName,'pickup'],[job.hauledTo||job.disposalName||job.dropOff,'dropoff']]) {
  if(typeof name!=='string'||!name.trim()||seen.has(name.trim().toUpperCase()))continue;
  seen.add(name.trim().toUpperCase());
  wells.push({name:name.trim(),type,jobType:String(job.commodityType||job.jobType||''),stampedAt:new Date(event.occurredAtMs).toISOString()});
 }
 // This is location metadata only. Completion and acknowledgment remain in
 // the immutable signed read/coverage records, never asserted by this mirror.
 return {driverId:owner.driverId,driverHash:owner.driverId,companyId:owner.companyId,shiftId:grant.shiftId,wells,locations:wells};
}

export async function projectOfflineLocations(db:admin.firestore.Firestore,owner:{driverId:string;companyId:string},event:OfflineEvent) {
 return db.runTransaction(async tx=>{
  const [grantSnap,receiptSnap,jobSnap]=await Promise.all([
   tx.get(db.doc('jsa_offline_grants/'+event.grantId)),tx.get(db.doc('jsa_offline_receipts/'+event.id)),tx.get(db.doc('invoices/'+event.jobRef)),
  ]);
  const grant=grantSnap.data() as OfflineGrant|undefined;
  if(!grant?.shiftId||grant.driverId!==owner.driverId||grant.companyId!==owner.companyId)throw Error('location_projection_identity');
  const ref=db.doc('jsa_day_status/'+owner.driverId+'_'+grant.shiftId),prior=await tx.get(ref);
  const patch=offlineLocationProjection(owner,event,grant,receiptSnap.data(),jobSnap.data(),prior.exists?prior.data():null);
  if(grant.mode!=='off')tx.set(ref,{...patch,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return {version:1,state:'confirmed',eventId:event.id,jobRef:event.jobRef};
 });
}
