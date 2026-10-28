/** Monotonic acknowledgement of an existing, reciprocally bound job start. */

const TERMINAL = new Set(['closed', 'complete', 'completed', 'cancelled', 'canceled', 'void']);
const ACCEPTED = new Set(['accepted', 'in_progress']);
const keys = new Set(['intent', 'invoiceId', 'dispatchId']);
const record = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
function id(value: any) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\/\u0000-\u001f\u007f]/.test(value);
}

// This is a monotonic acknowledgement of an already accepted job, never an
// invoice snapshot write. A delayed replay cannot resurrect or overwrite work.
export async function promoteDriverInvoiceStart(deps: any) {
  const { request, driver, firestore, HttpsError } = deps;
  const body = request.data;
  const auth = request.auth;
  if (!auth?.uid || auth.uid !== driver.uid || auth.token?.kind !== 'driver'
    || auth.token.driverId !== driver.driverId || auth.token.companyId !== driver.companyId
    || driver.authSource !== 'claims') throw new HttpsError('permission-denied', 'canonical_driver_required');
  if (!record(body) || Object.keys(body).some(key => !keys.has(key))
    || body.intent !== 'start' || !id(body.invoiceId) || !id(body.dispatchId)) {
    throw new HttpsError('invalid-argument', 'expected_start_invoice_dispatch_only');
  }
  const { invoiceId, dispatchId } = body;
  const result = await firestore.runTransaction(async (tx: any) => {
    const invoiceRef = firestore.collection('invoices').doc(invoiceId);
    const dispatchRef = firestore.collection('dispatches').doc(dispatchId);
    const [invoiceSnap, dispatchSnap] = await Promise.all([tx.get(invoiceRef), tx.get(dispatchRef)]);
    if (!invoiceSnap.exists || !dispatchSnap.exists) throw new HttpsError('not-found', 'start_records_missing');
    const invoice = invoiceSnap.data(), dispatch = dispatchSnap.data();
    for (const row of [invoice, dispatch]) {
      if (row.companyId !== driver.companyId || row.driverId !== driver.driverId) {
        throw new HttpsError('permission-denied', 'start_owner_mismatch');
      }
    }
    if (invoice.dispatchId !== dispatchId || dispatch.invoiceDocId !== invoiceId) {
      throw new HttpsError('failed-precondition', 'start_binding_mismatch');
    }
    const invoiceStatus = String(invoice.status || '').toLowerCase().trim();
    const dispatchStatus = String(dispatch.status || '').toLowerCase().trim();
    if (TERMINAL.has(invoiceStatus) || dispatchStatus === 'completed') return 'already_terminal';
    if (invoice.lockedForTransfer || invoice.activeTransferRequestId) throw new HttpsError('failed-precondition', 'transfer_pending');
    if (!ACCEPTED.has(dispatchStatus)) throw new HttpsError('failed-precondition', 'dispatch_not_accepted');
    if (invoice.previewNotStarted === false && invoice._jsaPreparedAnchor === false) return 'already_started';
    tx.update(invoiceRef, {
      previewNotStarted: false,
      _jsaPreparedAnchor: false,
      updatedAt: deps.serverTimestamp(),
    });
    return 'started';
  });
  await deps.writeSecurityAudit({
    action: 'promoteDriverInvoiceStart', actorUid: driver.uid, driverId: driver.driverId,
    detail: { invoiceId, dispatchId, result },
  });
  return { ok: true, invoiceId, dispatchId, result };
}

