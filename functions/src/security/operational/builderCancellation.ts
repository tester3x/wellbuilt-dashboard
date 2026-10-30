import * as https from 'firebase-functions/v2/https';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { splitCancellationPlan } from './ticketWaterCustody';

export type BuilderOwnership = { kind: 'driver' | 'staff'; actorId: string };
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
export function originalBuilder(job: Record<string, any>): BuilderOwnership {
  const birth = job.builderOwnership;
  if (birth !== undefined) {
    if (!birth || !['driver', 'staff'].includes(birth.kind) || !text(birth.actorId)) {
      throw new https.HttpsError('failed-precondition', 'Original builder identity is invalid');
    }
    return {kind: birth.kind, actorId: birth.actorId};
  }
  // These legacy birth markers are written by the authenticated create paths.
  // Entry screens, prefixes and request payloads never establish ownership.
  const by = text(job.assignedBy);
  if (job.source === 'driver' || by === 'driver' || by.startsWith('driver:')) {
    if (job.source && job.source !== 'driver') throw new https.HttpsError('failed-precondition', 'Conflicting builder identity');
    const actorId = by.startsWith('driver:') ? by.slice(7) : text(job.driverId);
    if (!actorId || actorId !== job.driverId) throw new https.HttpsError('failed-precondition', 'Original driver builder is ambiguous');
    return {kind:'driver',actorId};
  }
  if (by && !['driver', 'unknown'].includes(by.toLowerCase())) return {kind:'staff',actorId:by};
  throw new https.HttpsError('failed-precondition', 'Original builder identity is missing; retain the job for review');
}
export function assignmentTimeMs(value: any): number | null {
  const n = typeof value?.toMillis === 'function' ? value.toMillis()
    : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value)
    : typeof value?._seconds === 'number' ? value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6)
    : typeof value?.seconds === 'number' ? value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6) : NaN;
  return Number.isFinite(n) ? n : null;
}
const terminal = new Set(['completed','cancelled','canceled','declined','dismissed']);
const fail = (message: string): never => {throw new https.HttpsError('failed-precondition', message);};
export async function resolveBuilderCancellation(db: Firestore,
  driver: {driverId: string; companyId?: string; displayName?: string}, data: Record<string, any>) {
  const {dispatchId, invoiceDocId, reason = '', requestedAtMs, expectedAssignedAtMs} = data;
  const id = (v: any) => typeof v === 'string' && v.length > 0 && v.length <= 500 && !v.includes('/');
  if (!id(dispatchId) || typeof reason !== 'string' || reason.length > 2000
      || (invoiceDocId !== undefined && !id(invoiceDocId))
      || (!invoiceDocId && (!Number.isSafeInteger(requestedAtMs) || requestedAtMs <= 0 || !Number.isFinite(expectedAssignedAtMs)))) {
    throw new https.HttpsError('invalid-argument','Invalid builder cancellation request');
  }
  return db.runTransaction(async tx => {
    const ref = db.collection('dispatches').doc(dispatchId), snap = await tx.get(ref);
    if (!snap.exists) return {ok:true,cancellationPolicy:'builder-v1',result:'removed',affectedDispatchIds:[dispatchId]};
    const job = snap.data()!;
    const owned = (row: Record<string, any>) => {
      if (!driver.companyId || row.companyId !== driver.companyId || row.driverId !== driver.driverId) {
        throw new https.HttpsError('permission-denied','Cancellation ownership mismatch');
      }
    };
    owned(job);
    const assignedAtMs = assignmentTimeMs(job.assignedAt);
    if (!invoiceDocId && (assignedAtMs === null || assignedAtMs !== expectedAssignedAtMs)) fail('Assignment changed; reopen the current job');
    if (invoiceDocId && job.invoiceDocId !== invoiceDocId) fail('Cancellation belongs to an earlier invoice');
    const old = job.driverCancellation;
    if (old?.cancellationPolicy === 'builder-v1' && (invoiceDocId ? old.invoiceDocId === invoiceDocId
        : old.expectedAssignedAtMs === expectedAssignedAtMs && old.requestedAtMs === requestedAtMs)) {
      return old;
    }
    if (job.status === 'completed') fail('Completed work cannot be cancelled');
    if (['cancelled','canceled','declined','dismissed'].includes(job.status)) {
      return {ok:true,cancellationPolicy:'builder-v1',result:job.status === 'canceled' ? 'cancelled' : job.status,affectedDispatchIds:[dispatchId]};
    }
    if (!['pending','accepted','in_progress','paused'].includes(job.status)) fail('Job is not cancellable');
    const builder = originalBuilder(job);
    let family = [{id:dispatchId,ref,data:job}];
    let ledgerRef: ReturnType<ReturnType<Firestore['collection']>['doc']> | undefined;
    if (job.splitGroupId) {
      if (!id(job.splitGroupId)) fail('Invalid split group');
      const group = await tx.get(db.collection('dispatches').where('splitGroupId','==',job.splitGroupId));
      family = group.docs.map(doc=>({id:doc.id,ref:doc.ref,data:doc.data()}));
      const seq = new Set<number>();
      for (const member of family) {
        owned(member.data);
        const n = member.data.splitSequence;
        if (!Number.isSafeInteger(n) || n < 1 || seq.has(n)) fail('Split family topology is ambiguous');
        seq.add(n);
      }
      if (!seq.has(1) || !family.some(x=>x.id===dispatchId)) fail('Split anchor is missing');
      ledgerRef=db.collection('split_load_ledgers').doc(job.splitGroupId);
      await tx.get(ledgerRef);
    }
    const anchorCancellation = !!job.splitGroupId && job.splitSequence === 1;
    const targets = anchorCancellation ? family.filter(x=>!terminal.has(x.data.status)) : family.filter(x=>x.id===dispatchId);
    const invoices = new Map<string,{ref: FirebaseFirestore.DocumentReference;data: Record<string,any>}>();
    // Read every dependency before the first mutation. A refusal changes nothing.
    for (const member of targets) {
      if (member.data.invoiceDocId) {
        if (!id(member.data.invoiceDocId)) fail('Invalid invoice linkage');
        const invoiceRef=db.collection('invoices').doc(member.data.invoiceDocId), inv=await tx.get(invoiceRef);
        if (!inv.exists) fail('Linked invoice is missing');
        const record=inv.data()!;
        if (record.companyId !== driver.companyId || record.driverId !== driver.driverId || record.dispatchId !== member.id) fail('Invoice linkage mismatch');
        if (record.status === 'open') invoices.set(member.id,{ref:invoiceRef,data:record});
        else if (member.data.status !== 'pending') fail('Linked invoice is already terminal');
      } else if (member.data.status !== 'pending') fail('Started job has no verified invoice');
    }
    const currentInvoice=invoices.get(dispatchId)?.data;
    let splitPlan: ReturnType<typeof splitCancellationPlan> | undefined;
    if (job.splitGroupId && Number(job.splitSequence)>=2) {
      splitPlan=splitCancellationPlan(job,family.map(x=>({...x.data,id:x.id})),currentInvoice);
      if (splitPlan.kind==='divert' || splitPlan.kind==='unverified') fail('Split still holds water or its balance is unverified; deliver or transfer it');
    }
    for (const member of targets) {
      const inv=invoices.get(member.id)?.data;
      const owner=originalBuilder(member.data);
      if (anchorCancellation && (owner.kind !== builder.kind || owner.actorId !== builder.actorId)) fail('Split builder ownership is inconsistent');
      if (inv?.transferSourceDocId || inv?.lockedForTransfer || inv?.activeTransferRequestId
          || (inv?.tickets?.length || 0)>0 || (member.data.status !== 'pending' && member.data.lastPullPacketId)
          || (Number(inv?.totalBBL)>0 && !(member.id===dispatchId && splitPlan?.kind==='release'))) fail('Loaded or transferred job cannot be cancelled');
    }
    const result=builder.kind==='driver'?'cancelled':'declined';
    const carry=splitPlan?.kind==='release' ? (({kind,...rest})=>rest)(splitPlan) : undefined;
    const receipt: Record<string,any>={ok:true,cancellationPolicy:'builder-v1',result,
      affectedDispatchIds:targets.map(x=>x.id),...(invoiceDocId?{invoiceDocId}:{expectedAssignedAtMs,requestedAtMs}),
      ...(carry?{splitCancellationCarry:carry}:{})};
    if (carry) tx.update(db.collection('dispatches').doc(carry.nextDispatchId),{
      inheritedBbls:carry.remainingBbls,splitCancellationSourceDispatchId:dispatchId,
    });
    if (ledgerRef) tx.set(ledgerRef,{lastCancellationDispatchId:dispatchId,updatedAt:FieldValue.serverTimestamp()},{merge:true});
    for (const member of targets) {
      const owner=originalBuilder(member.data), status=owner.kind==='driver'?'cancelled':'declined';
      tx.update(member.ref,{
        status,builderOwnership:owner,driverCancellation:receipt,
        cancelReason:reason,declineReason:reason,declinedBy:driver.displayName || driver.driverId,declinedAt:Date.now(),
        ...(status==='cancelled'?{cancelledAt:Date.now()}:{}),
        ...(carry && member.id===dispatchId?{splitCancellationCarry:carry}:{}),
        driverStage:FieldValue.delete(),driverDest:FieldValue.delete(),stageUpdatedAt:FieldValue.delete(),
        driverLat:FieldValue.delete(),driverLng:FieldValue.delete(),driverGpsAt:FieldValue.delete(),updatedAt:FieldValue.serverTimestamp(),
      });
      const inv=invoices.get(member.id);
      if (inv) tx.update(inv.ref,{status:'cancelled',driverState:'idle',cancelReason:reason,cancelledAt:FieldValue.serverTimestamp()});
    }
    return receipt;
  });
}
