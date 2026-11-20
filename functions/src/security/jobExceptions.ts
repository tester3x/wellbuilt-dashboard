import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { resolveSubject } from './operational/shiftAuthorityCallables';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { exceptionMode, parseExceptionScope, exceptionBinding, maySelfApprove } from './jobExceptionPolicy';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
const fail = (message: string) => new HttpsError('failed-precondition', message);
function note(raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000) throw new HttpsError('invalid-argument', 'Enter a reason for this exception');
  return raw.trim();
}
function owned(job: admin.firestore.DocumentSnapshot, owner: {companyId: string; driverId: string}) {
  if (!job.exists || job.get('companyId') !== owner.companyId
      || (job.get('driverId') || job.get('driverHash')) !== owner.driverId) throw new HttpsError('permission-denied', 'Job is not yours');
  if (!['open', 'active'].includes(job.get('status') || 'open') || job.get('closedAt')) throw fail('This job is no longer open');
}
export async function driverJobExceptionsHandler(request: CallableRequest<any>) {
  if (request.auth?.token?.app !== 'wbt') throw new HttpsError('permission-denied', 'WB Tickets driver session required');
  const owner = await resolveSubject(request), data = request.data || {};
  if (!['status', 'request', 'selfApprove'].includes(data.action)) throw new HttpsError('invalid-argument', 'Unknown action');
  let scope;
  try { scope = parseExceptionScope(data.scope); } catch (e) { throw new HttpsError('invalid-argument', (e as Error).message); }
  const reason = data.action === 'status' ? '' : note(data.reason);
  const db = admin.firestore(), company = db.collection('companies').doc(owner.companyId);
  return db.runTransaction(async tx => {
    const companyRow = await tx.get(company);
    if (!companyRow.exists) throw fail('Company is unavailable');
    let mode;
    try { mode = exceptionMode(companyRow.data()!); } catch (e) { throw fail((e as Error).message); }
    // Never consult caller roles or client company/mode fields for self approval.
    if (data.action === 'selfApprove' && !maySelfApprove(mode)) throw new HttpsError('permission-denied', 'Dispatch/admin must approve this exception from the review screen');
    const binding = exceptionBinding(owner.companyId, owner.driverId, mode, scope), id = hash(binding);
    const ref = company.collection('job_exception_requests').doc(id);
    const [job, prior] = await Promise.all([tx.get(db.collection('invoices').doc(scope.jobId)), tx.get(ref)]);
    owned(job, owner);
    if (job.get('haulGroupId') || job.get('dispatchSplitGroupId') || job.get('splitChainSeq') || job.get('transferSourceDocId')) throw fail('This job uses a separate grouped/transfer workflow');
    if (prior.exists && prior.get('binding') !== binding) throw fail('Exception details changed');
    if (data.action === 'status') return { id, mode, status: prior.exists ? prior.get('status') : 'none', binding };
    if (prior.exists && prior.get('status') === 'approved') return { id, mode, status: 'approved', binding };
    if (prior.exists && prior.get('status') === 'rejected') throw fail('This exception was rejected. Review the job with dispatch.');
    const status = data.action === 'selfApprove' ? 'approved' : 'pending';
    const row = { schemaVersion: 1, kind: 'same_site_pw', ...owner, scope, binding, mode, reason, status,
      requestedBy: request.auth!.uid, createdAt: timestamp(),
      ...(status === 'approved' ? { reviewedBy: request.auth!.uid, reviewSource: 'independent_driver', reviewedAt: timestamp() } : {}) };
    if (!prior.exists) tx.create(ref, row);
    else if (status === 'approved') tx.update(ref, { status, reviewedBy: request.auth!.uid, reviewSource: 'independent_driver', reviewedAt: timestamp(), reason });
    return { id, mode, status, binding };
  });
}
export async function reviewJobExceptionsHandler(request: CallableRequest<any>) {
  // The same person may explicitly review in Dashboard, but never through a
  // driver-audience token, even when their uid has trusted staff capabilities.
  if (request.auth?.token?.kind === 'driver') throw new HttpsError('permission-denied', 'Open the dispatch/admin review screen with a staff session');
  let staff;
  try { staff = await requireTrustedCompanyCapability(request.auth?.uid, 'createDispatch'); }
  catch { staff = await requireTrustedCompanyCapability(request.auth?.uid, 'manageCompany'); }
  const db = admin.firestore(), company = db.collection('companies').doc(staff.companyId), data = request.data || {};
  if (data.action === 'list') {
    const rows = await company.collection('job_exception_requests').where('status', '==', 'pending').limit(100).get();
    return { companyId: staff.companyId, items: rows.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.get('createdAt')?.toDate?.().toISOString() || null })) };
  }
  if (!['approve', 'reject'].includes(data.action) || !/^[a-f0-9]{64}$/.test(data.id || '')) throw new HttpsError('invalid-argument', 'Invalid review');
  const reviewNote = note(data.note), ref = company.collection('job_exception_requests').doc(data.id);
  return db.runTransaction(async tx => {
    const [row, cfg] = await Promise.all([tx.get(ref), tx.get(company)]);
    if (!row.exists || row.get('companyId') !== staff.companyId) throw new HttpsError('not-found', 'Exception not found');
    if (row.get('status') !== 'pending') throw fail('This exception has already been reviewed');
    if (data.action === 'reject') {
      tx.update(ref, { status: 'rejected', reviewedBy: staff.uid, reviewedAt: timestamp(), reviewSource: 'staff_review', reviewNote });
      return { id: ref.id, status: 'rejected' };
    }
    if (!cfg.exists) throw fail('Company is unavailable');
    let mode;
    try { mode = exceptionMode(cfg.data()!); } catch (e) { throw fail((e as Error).message); }
    if (mode !== row.get('mode')) throw fail('Company mode changed. Request a fresh review.');
    const scope = parseExceptionScope(row.get('scope'));
    if (exceptionBinding(staff.companyId, row.get('driverId'), mode, scope) !== row.get('binding')) throw fail('Exception binding is invalid');
    const job = await tx.get(db.collection('invoices').doc(scope.jobId));
    owned(job, { companyId: staff.companyId, driverId: row.get('driverId') });
    const status = data.action === 'approve' ? 'approved' : 'rejected';
    tx.update(ref, { status, reviewedBy: staff.uid, reviewedAt: timestamp(), reviewSource: 'staff_review', reviewNote });
    return { id: ref.id, status };
  });
}
export const driverJobExceptions = onCall({ region: 'us-central1' }, driverJobExceptionsHandler);
export const reviewJobExceptions = onCall({ region: 'us-central1' }, reviewJobExceptionsHandler);
