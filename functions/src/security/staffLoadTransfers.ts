import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';

function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new https.HttpsError('invalid-argument', 'Invalid identifier');
  return value;
}
function serial(value: any): any {
  if (value?.toDate instanceof Function) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serial);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serial(v)]));
  return value;
}
export const staffLoadTransfers = https.onCall({ timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false, invoker: 'public' }, async request => {
  const data = request.data || {}, action = data.action;
  if (!['list', 'assign', 'decline'].includes(action)) throw new https.HttpsError('invalid-argument', 'Unknown transfer action');
  for (const field of Object.keys(data)) if (!['action', 'requestId', 'driverId', 'viewedCompanyId'].includes(field)) throw new https.HttpsError('invalid-argument', `Unexpected field: ${field}`);
  const staff = await requireTrustedCompanyCapability(request.auth?.uid, action === 'list' ? 'viewDispatch' : 'createDispatch');
  if (data.viewedCompanyId && data.viewedCompanyId !== staff.companyId) throw new https.HttpsError('permission-denied', 'Selected company is outside your dispatch authority');
  const db = admin.firestore();
  if (action === 'list') {
    const [requests, profiles] = await Promise.all([
      db.collection('transfer_requests').where('companyId', '==', staff.companyId).where('status', '==', 'pending').get(),
      admin.database().ref('drivers/profiles').orderByChild('companyId').equalTo(staff.companyId).once('value'),
    ]);
    return { companyId: staff.companyId,
      requests: serial(requests.docs.map(doc => ({ ...doc.data(), id: doc.id }))),
      drivers: Object.entries(profiles.val() || {}).filter(([, raw]) => (raw as any).active !== false && (raw as any).companyId === staff.companyId)
        .map(([id, raw]) => ({ id, name: (raw as any).legalName || (raw as any).displayName || 'Driver' })),
    };
  }
  const requestId = key(data.requestId), ref = db.collection('transfer_requests').doc(requestId);
  let target: { id: string; name: string } | null = null;
  if (action === 'assign') {
    const id = key(data.driverId), profile = (await admin.database().ref(`drivers/profiles/${id}`).once('value')).val();
    if (!profile || profile.active === false || profile.companyId !== staff.companyId) throw new https.HttpsError('permission-denied', 'Recipient must be an active driver in this company');
    target = { id, name: profile.legalName || profile.displayName || 'Driver' };
  }
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref), row = snap.data();
    if (!row || row.companyId !== staff.companyId) throw new https.HttpsError('permission-denied', 'Transfer outside your company');
    const invoiceRef = db.collection('invoices').doc(key(row.sourceInvoiceDocId)), invoice = await tx.get(invoiceRef), inv = invoice.data();
    if (row.status !== 'pending' || !inv || inv.companyId !== staff.companyId || !inv.lockedForTransfer || inv.activeTransferRequestId !== requestId
      || (inv.driverId || inv.driverHash) !== (row.fromDriverId || row.fromDriverHash)) throw new https.HttpsError('failed-precondition', 'Transfer is no longer awaiting assignment');
    const now = admin.firestore.FieldValue.serverTimestamp();
    if (action === 'assign') {
      if (row.mode !== 'approval') throw new https.HttpsError('failed-precondition', 'Direct offers are selected by the sending driver');
      if (target!.id === (row.fromDriverId || row.fromDriverHash)) throw new https.HttpsError('invalid-argument', 'Choose another driver');
      if (row.toDriverId === target!.id) return { ok: true, alreadyAssigned: true, requestId };
      // Assignment authorizes an offer only. Ownership changes solely in the
      // receiver's authenticated acceptance transaction.
      tx.update(ref, { toDriverId: target!.id, toDriverHash: target!.id, toDriverName: target!.name, assignedBy: staff.uid, assignedAt: now, updatedAt: now });
    } else {
      tx.update(ref, { status: 'declined', terminalBy: staff.uid, terminalAt: now, terminalReason: 'Declined by dispatch', updatedAt: now });
      tx.update(invoiceRef, { activeTransferRequestId: admin.firestore.FieldValue.delete(), lockedForTransfer: false, updatedAt: now });
    }
    return { ok: true, requestId };
  });
});
