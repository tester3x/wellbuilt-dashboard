import { createHash } from 'node:crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { freshWaterDefaultRef, freshWaterDefaultsCollection, normalizeFreshWaterCustomer, readFreshWaterDefault } from './freshWaterAccountDefaults';

const companyStatuses = ['awaiting_bill', 'ready_to_rebill', 'billed_back', 'not_reimbursable'];

export const staffFreshWaterPurchases = onCall(async request => {
  const input = request.data ?? {};
  const { op, ticketId } = input;
  if (op === 'listDefaults' || op === 'saveDefault') {
    const capability = op === 'saveDefault' ? 'editBilling'
      : input.forDispatch === true ? 'manageDrivers' : 'viewBilling';
    const { uid, companyId } = await requireTrustedCompanyCapability(request.auth?.uid, capability);
    if (input.companyId !== companyId) throw new HttpsError('permission-denied', 'Customer settings unavailable.');
    const db = getFirestore();
    const company = db.collection('companies').doc(companyId);
    if (op === 'listDefaults') {
      const snapshot = await freshWaterDefaultsCollection(db, companyId).get();
      return { defaults: snapshot.docs.map(doc => {
        const { operator, account } = doc.data();
        return { operator, account };
      }) };
    }
    const { operator, account } = input;
    if (typeof operator !== 'string' || !operator.trim() || operator.length > 200
        || (account !== null && account !== 'customer' && account !== 'company')) {
      throw new HttpsError('invalid-argument', 'Choose a customer and a valid depot account.');
    }
    const name = normalizeFreshWaterCustomer(operator);
    const operators: unknown = (await company.get()).data()?.assignedOperators;
    if (!Array.isArray(operators) || !operators.some(value => normalizeFreshWaterCustomer(value) === name)) {
      throw new HttpsError('not-found', 'Customer unavailable.');
    }
    const ref = freshWaterDefaultRef(db, companyId, name);
    if (account === null) await ref.delete();
    else await ref.set({ operator: name, account, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    return { account };
  }

  if ((op !== 'list' && op !== 'save') || typeof ticketId !== 'string'
      || !ticketId || ticketId.length > 512 || ticketId.includes('/') || ticketId === '.' || ticketId === '..') {
    throw new HttpsError('invalid-argument', 'A valid Fresh Water ticket is required.');
  }
  const { uid, companyId } = await requireTrustedCompanyCapability(
    request.auth?.uid, op === 'list' ? 'viewBilling' : 'editBilling',
  );
  const db = getFirestore();
  const ticketRef = db.collection('tickets').doc(ticketId);
  const purchases = db.collection('companies').doc(companyId).collection('fresh_water_purchases');
  const checkTicket = (data: FirebaseFirestore.DocumentData | undefined) => {
    if (!data || data.companyId !== companyId) {
      throw new HttpsError('not-found', 'Fresh Water ticket unavailable.');
    }
    const type = data.type || data.commodityType;
    if (typeof type !== 'string' || !/^(fresh[\s_-]*water(?:[\s_-]*tank[\s_-]*refill)?|fw)$/i.test(type.trim())) {
      throw new HttpsError('failed-precondition', 'This ticket is outside the Fresh Water workflow.');
    }
    return data;
  };
  if (op === 'list') {
    const ticket = checkTicket((await ticketRef.get()).data());
    const dispatchId = typeof ticket.dispatchId === 'string' ? ticket.dispatchId : '';
    const dispatchRead = dispatchId && !dispatchId.includes('/') && dispatchId !== '.' && dispatchId !== '..'
      ? db.collection('dispatches').doc(dispatchId).get() : Promise.resolve(undefined);
    const [snapshot, dispatchSnapshot, customerDefault] = await Promise.all([
      purchases.where('ticketId', '==', ticketId).get(),
      dispatchRead,
      !dispatchId ? readFreshWaterDefault(db, companyId, ticket.operator || ticket.company, ref => ref.get()) : null,
    ]);
    const dispatch = dispatchSnapshot?.data();
    const plannedAccount = dispatch?.companyId === companyId ? dispatch?.freshWaterAccount : null;
    return {
      plannedAccount: plannedAccount === 'customer' || plannedAccount === 'company' ? plannedAccount : null,
      customerDefault,
      purchases: snapshot.docs.map(doc => {
        const { receipt, account, amountCents, status, invoiceRef, revision } = doc.data();
        return { id: doc.id, receipt, account, amountCents, status, invoiceRef, revision };
      }),
    };
  }

  const receipt = typeof input.receipt === 'string' ? input.receipt.trim() : '';
  const invoiceRef = typeof input.invoiceRef === 'string' ? input.invoiceRef.trim() : '';
  const { id, account, amountCents, status, revision } = input;
  if (!receipt || receipt.length > 120 || invoiceRef.length > 120
      || (account !== 'customer' && account !== 'company')
      || !Number.isSafeInteger(revision) || revision < 0
      || (revision === 0 ? id != null : typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      || (account === 'customer' && (amountCents !== null || status !== 'customer_billed' || invoiceRef))
      || (account === 'company' && (!companyStatuses.includes(status)
        || (amountCents === null ? status !== 'awaiting_bill' : !Number.isSafeInteger(amountCents) || amountCents < 0)
        || (status === 'billed_back' ? !invoiceRef : !!invoiceRef)))) {
    throw new HttpsError('invalid-argument', 'Check the receipt, depot account, amount and billing status.');
  }

  return db.runTransaction(async transaction => {
    const ticket = checkTicket((await transaction.get(ticketRef)).data());
    if (ticket.status === 'void') throw new HttpsError('failed-precondition', 'This ticket is void.');
    const location = ticket.location || ticket.wellName;
    const depot = typeof location === 'string' ? location.trim() : '';
    if (!depot) throw new HttpsError('failed-precondition', 'This ticket needs a depot location.');
    const receiptKey = createHash('sha256')
      .update(JSON.stringify([depot.toLowerCase(), receipt.toLowerCase()])).digest('hex');
    const ref = purchases.doc(id ?? receiptKey);
    const existing = (await transaction.get(ref)).data();
    if (existing && existing.ticketId !== ticketId) {
      throw new HttpsError('already-exists', 'This depot receipt is already linked to another ticket.');
    }
    if (id && (!existing || existing.receipt !== receipt)) {
      throw new HttpsError('failed-precondition', 'Reload the receipt before editing it.');
    }
    const purchase = { receipt: existing?.receipt ?? receipt, account, amountCents, status, invoiceRef };
    if (existing && Object.entries(purchase).every(([key, value]) => existing[key] === value)) {
      return { purchase: { ...purchase, id: ref.id, revision: existing.revision } };
    }
    if (revision !== (existing?.revision ?? 0)) {
      throw new HttpsError('aborted', 'This receipt changed. Reload it before saving again.');
    }
    const updated = { ...purchase, revision: revision + 1 };
    transaction.set(ref, {
      ...updated,
      ticketId,
      depot: existing?.depot ?? depot,
      updatedBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { purchase: { ...updated, id: ref.id } };
  });
});
