import * as https from 'firebase-functions/v2/https';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

/** Cancellation releases a reservation, never consumes or adds physical water. */
export function splitCancellationPlan(job: Record<string, any>, family: Record<string, any>[], invoice?: Record<string, any>) {
  const owned = family.filter(other => other.companyId === job.companyId && other.driverId === job.driverId
    && other.splitGroupId === job.splitGroupId);
  const afterPickup = job.status !== 'pending' || owned.some(other => Number(other.splitSequence) < Number(job.splitSequence) && other.status === 'completed');
  if (!afterPickup) return {kind:'unstarted' as const}; // unloaded A family cancellation / A diversion
  const next = owned.filter(other => Number(other.splitSequence) > Number(job.splitSequence)
    && !['completed','cancelled','declined','dismissed'].includes(other.status))
    .sort((a,b) => Number(a.splitSequence)-Number(b.splitSequence))[0];
  const carry = invoice?.dispatchCarryBbls ?? job.inheritedBbls;
  const knownCarry = typeof carry === 'number' && Number.isFinite(carry) && carry >= 0;
  if (!next) return knownCarry && carry === 0 && !(Number(invoice?.totalBBL)>0)
    ? {kind:'empty' as const} : {kind:'divert' as const};
  if (!invoice) return {kind:job.status === 'pending' ? 'unstarted' as const : 'unverified' as const};
  if (!knownCarry || Number(invoice.totalBBL || 0) > carry || next.status !== 'pending' || next.invoiceDocId) {
    return {kind:'unverified' as const};
  }
  return {kind:'release' as const, nextDispatchId:next.id as string, remainingBbls:carry,
    releasedAllocatedBbls:Math.max(0,Number(invoice.totalBBL)||0), splitGroupId:job.splitGroupId as string};
}

export function unfinishedTicketInvoice(invoice: Record<string, any>): boolean {
  if (invoice.status !== 'open' || invoice.previewNotStarted || invoice._invoiceDeferredCreate) return false;
  return Number(invoice.totalBBL) > 0 || invoice.tickets?.length > 0
    || invoice.timeline?.some((event: any) => ['accept', 'arrive', 'depart', 'depart_site', 'resume'].includes(event.type))
    || (!!invoice.dispatchId && !!invoice.dispatchSplitGroupId);
}

export async function assertNoUnfinishedTicketJobs(tx: Transaction, db: Firestore,
  who: { companyId: string; driverId: string }): Promise<void> {
  const owned = (collection: string) => db.collection(collection)
    .where('companyId', '==', who.companyId).where('driverId', '==', who.driverId);
  const [invoices, running, paused] = await Promise.all([
    tx.get(owned('invoices').where('status', '==', 'open')),
    tx.get(owned('dispatches').where('status', '==', 'in_progress')),
    tx.get(owned('dispatches').where('status', '==', 'paused')),
  ]);
  if (invoices.docs.some(doc => unfinishedTicketInvoice(doc.data())) || !running.empty || !paused.empty) {
    throw new https.HttpsError('failed-precondition', 'unfinished_ticket_jobs');
  }
}
