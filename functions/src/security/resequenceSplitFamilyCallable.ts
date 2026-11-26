import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {requireSecureDriver} from './requireDriverAuth';
import {planSplitFamilyReorder} from './operational/splitReorderPlan';
const text=(v:unknown)=>typeof v==='string'?v.trim():'';
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=500&&!v.includes('/');

export const resequenceSplitFamily=https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
  const driver=await requireSecureDriver(request,{allowLegacyHash:false});
  if(!driver.companyId)throw new https.HttpsError('failed-precondition','unscoped_driver');
  const input=(request.data||{}) as Record<string,unknown>;
  if(Object.keys(input).some(k=>!['splitGroupId','orderedLegIds','callerDriverHash'].includes(k))
      ||!validId(input.splitGroupId)||!Array.isArray(input.orderedLegIds)||!input.orderedLegIds.length
      ||input.orderedLegIds.length>100||!input.orderedLegIds.every(validId))
    throw new https.HttpsError('invalid-argument','invalid_split_order');
  // callerDriverHash is accepted for older request envelopes, never as authority.
  const group=input.splitGroupId,ids=input.orderedLegIds as string[];
  const db=admin.firestore(),dispatches=db.collection('dispatches');
  const eventRef=db.collection('split_reorder_events').doc();
  const owned=(row:Record<string,any>)=>row.companyId===driver.companyId&&row.driverId===driver.driverId;
  return db.runTransaction(async tx=>{
    const snapshot=await tx.get(dispatches.where('splitGroupId','==',group).limit(101));
    if(snapshot.empty)throw new https.HttpsError('not-found','split_family_not_found');
    const family=snapshot.docs.map(d=>({id:d.id,ref:d.ref,data:d.data()}));
    if(family.length>100)throw new https.HttpsError('failed-precondition','split_family_too_large');
    if(family.some(l=>!owned(l.data)))throw new https.HttpsError('permission-denied','family_owner_mismatch');
    const plan=planSplitFamilyReorder(family.map(l=>({id:l.id,splitSequence:l.data.splitSequence,
      status:text(l.data.status),wellName:text(l.data.wellName),ndicWellName:text(l.data.ndicWellName)})),ids);
    if(!plan.ok)throw new https.HttpsError('failed-precondition',plan.reason);
    const byId=new Map(family.map(l=>[l.id,l]));
    const live=plan.order.map(o=>byId.get(o.id)!);
    if(live.some(l=>l.data.lockedForTransfer||l.data.activeTransferRequestId))
      throw new https.HttpsError('failed-precondition','transfer_pending');
    const invoiceSnapshot=await tx.get(db.collection('invoices').where('dispatchSplitGroupId','==',group).limit(101));
    if(invoiceSnapshot.size>100)throw new https.HttpsError('failed-precondition','split_invoice_history_too_large');
    const invoices=new Map(invoiceSnapshot.docs.map(d=>[d.id,{ref:d.ref,data:d.data()}]));
    for(const leg of live){
      const id=leg.data.invoiceDocId;
      if(id!=null){
        if(!validId(id))throw new https.HttpsError('failed-precondition','invalid_invoice_link');
        if(!invoices.has(id)){const s=await tx.get(db.collection('invoices').doc(id));
          if(!s.exists)throw new https.HttpsError('failed-precondition','linked_invoice_missing');
          invoices.set(id,{ref:s.ref,data:s.data()!});}
      }else if(leg.data.status!=='pending')throw new https.HttpsError('failed-precondition','started_invoice_unconfirmed');
    }
    const mirrors:Array<{ref:FirebaseFirestore.DocumentReference;data:Record<string,any>;dispatchId:string}>=[];
    for(const [id,invoice] of invoices){
      if(!owned(invoice.data))throw new https.HttpsError('permission-denied','invoice_owner_mismatch');
      const dispatchId=text(invoice.data.dispatchId),leg=byId.get(dispatchId);
      if(!leg)throw new https.HttpsError('failed-precondition','invoice_family_mismatch');
      if(!ids.includes(dispatchId)||leg.data.invoiceDocId!==id)continue; // Retain completed/older cycles unchanged.
      if(invoice.data.dispatchSplitGroupId!==group||invoice.data.status!=='open'
          ||invoice.data.lockedForTransfer||invoice.data.activeTransferRequestId)
        throw new https.HttpsError('failed-precondition','invoice_not_reorderable');
      if(plan.rerouteAnchor?.id===dispatchId && Array.isArray(invoice.data.timeline)
          && invoice.data.timeline.some((e:any)=>['depart_site','arrive_dropoff'].includes(e?.type)))
        throw new https.HttpsError('failed-precondition','first_destination_already_started');
      mirrors.push({...invoice,dispatchId});
    }
    const changed=plan.order.some(o=>{const l=byId.get(o.id)!;return l.data.splitSequence!==o.splitSequence
      ||l.data.splitTotal!==ids.length;});
    if(!changed)return {splitGroupId:group,newTotal:ids.length,base:plan.base,order:plan.order};
    const now=admin.firestore.Timestamp.now();
    for(const o of plan.order){
      const update:Record<string,unknown>={splitSequence:o.splitSequence,splitTotal:ids.length,updatedAt:now};
      if(o.id===plan.rerouteAnchor?.id)Object.assign(update,{disposal:plan.rerouteAnchor.destination,
        disposalName:plan.rerouteAnchor.destination,disposalLat:null,disposalLng:null,destinationType:null});
      tx.update(byId.get(o.id)!.ref,update);
    }
    const sequences=new Map(plan.order.map(o=>[o.id,o.splitSequence]));
    for(const invoice of mirrors){
      const update:Record<string,unknown>={dispatchSplitSequence:sequences.get(invoice.dispatchId),dispatchSplitTotal:ids.length,updatedAt:now};
      if(invoice.dispatchId===plan.rerouteAnchor?.id)Object.assign(update,{hauledTo:plan.rerouteAnchor.destination,hauledToLat:null,hauledToLng:null});
      tx.update(invoice.ref,update);
    }
    tx.create(eventRef,{companyId:driver.companyId,driverId:driver.driverId,splitGroupId:group,at:now,
      previousOrder:live.slice().sort((a,b)=>a.data.splitSequence-b.data.splitSequence).map(l=>l.id),
      order:plan.order,...(plan.rerouteAnchor?{rerouteAnchor:plan.rerouteAnchor}:{})});
    return {splitGroupId:group,newTotal:ids.length,base:plan.base,order:plan.order};
  });
});
