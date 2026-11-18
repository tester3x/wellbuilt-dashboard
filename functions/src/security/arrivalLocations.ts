import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { requireSecureDriver } from './requireDriverAuth';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';

const clean = (value: unknown, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpsError('invalid-argument', 'Invalid location details');
  return value.trim();
};
function point(data: any) {
  const { latitude, longitude } = data;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) {
    throw new HttpsError('invalid-argument', 'Invalid GPS point');
  }
  return { latitude, longitude };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const locationId = (name: string) => hash(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' '));
const companyRef = (id: string) => admin.firestore().collection('companies').doc(id);

export async function driverArrivalLocationsHandler(request: CallableRequest<any>) {
  const driver = await requireSecureDriver(request, { allowLegacyHash: false });
  if (!driver.companyId) throw new HttpsError('failed-precondition', 'A company is required for location review');
  const data = request.data || {}, company = companyRef(driver.companyId);
  if (data.action === 'list') {
    const snap = await company.collection('verified_arrival_locations').limit(1000).get();
    return { companyId: driver.companyId, items: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
  }
  if (data.action === 'logChange') {
    const jobId = clean(data.jobId, 160), requestId = clean(data.requestId, 160);
    const from = clean(data.from), to = clean(data.to);
    const observedAt = Date.parse(data.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > Date.now() + 60000) throw new HttpsError('invalid-argument', 'Invalid change time');
    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : '';
    const invoice = admin.firestore().collection('invoices').doc(jobId);
    const event = invoice.collection('dropoff_changes').doc(hash(driver.driverId + '/' + requestId));
    await admin.firestore().runTransaction(async tx => {
      const [job, prior] = await Promise.all([tx.get(invoice), tx.get(event)]);
      if (!job.exists || job.get('companyId') !== driver.companyId
          || (job.get('driverId') || job.get('driverHash')) !== driver.driverId) throw new HttpsError('permission-denied', 'Job is not yours');
      if (prior.exists) {
        if (prior.get('from') !== from || prior.get('to') !== to || prior.get('reason') !== reason) throw new HttpsError('already-exists', 'Change ID was reused');
        return;
      }
      const canonicalId = job.get('canonicalJobId');
      const canonical = typeof canonicalId === 'string' && canonicalId ? admin.firestore().collection('canonical_jobs').doc(canonicalId) : null;
      const canonicalRow = canonical ? await tx.get(canonical) : null;
      tx.create(event, { companyId: driver.companyId, driverId: driver.driverId, from, to, reason,
        observedAt: new Date(observedAt).toISOString(), loggedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (canonical && canonicalRow?.exists && canonicalRow.get('companyId') === driver.companyId && canonicalRow.get('invoiceDocId') === jobId) {
        tx.update(canonical, { events: admin.firestore.FieldValue.arrayUnion({ type: 'edited', timestamp: observedAt,
          actorDriverHash: driver.driverId, actorSource: 'wbt', notes: 'Drop-off changed: ' + from + ' → ' + to + (reason ? '. Reason: ' + reason : ''),
          extra: { changeId: event.id, from, to, reason } }) });
      }
    });
    return { status: 'logged' };
  }
  if (data.action !== 'propose') throw new HttpsError('invalid-argument', 'Unknown action');
  const name = clean(data.locationName), requestId = clean(data.requestId, 160), jobId = clean(data.jobId, 160);
  const gps = point(data);
  const observedAt = Date.parse(data.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() + 60000) throw new HttpsError('invalid-argument', 'Invalid GPS time');
  if (typeof data.accuracy !== 'number' || !Number.isFinite(data.accuracy) || data.accuracy < 0 || data.accuracy > 50) {
    throw new HttpsError('invalid-argument', 'A precise GPS point is required');
  }
  const id = hash(driver.driverId + '/' + requestId);
  const ref = company.collection('arrival_location_requests').doc(id);
  await admin.firestore().runTransaction(async tx => {
    const prior = await tx.get(ref);
    if (prior.exists) {
      const old = prior.data()!;
      if (old.driverId !== driver.driverId || old.jobId !== jobId || old.locationName !== name
          || old.latitude !== gps.latitude || old.longitude !== gps.longitude) throw new HttpsError('already-exists', 'Request ID was reused');
      return;
    }
    tx.create(ref, { companyId: driver.companyId, driverId: driver.driverId, driverName: driver.displayName || '',
      jobId, locationName: name, locationType: ['swd', 'well', 'place'].includes(data.locationType) ? data.locationType : 'place',
      ...gps, accuracy: data.accuracy, observedAt: new Date(observedAt).toISOString(), status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { id, status: 'pending', companyId: driver.companyId };
}

export async function reviewArrivalLocationsHandler(request: CallableRequest<any>) {
  let staff;
  try { staff = await requireTrustedCompanyCapability(request.auth?.uid, 'createDispatch'); }
  catch { staff = await requireTrustedCompanyCapability(request.auth?.uid, 'manageCompany'); }
  const data = request.data || {}, company = companyRef(staff.companyId);
  if (data.action === 'list') {
    const snap = await company.collection('arrival_location_requests').where('status', '==', 'pending').limit(100).get();
    return { companyId: staff.companyId, items: snap.docs.map(doc => ({ id: doc.id, ...doc.data(),
      createdAt: doc.get('createdAt')?.toDate?.().toISOString() || null })) };
  }
  if (!['approve', 'reject'].includes(data.action)) throw new HttpsError('invalid-argument', 'Unknown action');
  const id = clean(data.id, 64);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpsError('invalid-argument', 'Invalid request');
  const gps = data.action === 'approve' ? point(data) : null;
  if (gps && (typeof data.radius !== 'number' || !Number.isFinite(data.radius) || data.radius < 10 || data.radius > 10000)) {
    throw new HttpsError('invalid-argument', 'Enter an arrival radius between 10 and 10000 meters');
  }
  if (gps && data.mapVerified !== true) throw new HttpsError('failed-precondition', 'Verify the map point before approval');
  const ref = company.collection('arrival_location_requests').doc(id);
  return admin.firestore().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('companyId') !== staff.companyId) throw new HttpsError('not-found', 'Location request not found');
    if (snap.get('status') !== 'pending') throw new HttpsError('failed-precondition', 'This request has already been reviewed');
    const row = snap.data()!, status = gps ? 'approved' : 'rejected';
    tx.update(ref, { status, reviewedBy: staff.uid, reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewNote: typeof data.note === 'string' ? data.note.slice(0, 1000) : '',
      ...(gps ? { approvedPoint: { ...gps, radius: data.radius } } : {}) });
    if (gps) tx.set(company.collection('verified_arrival_locations').doc(locationId(row.locationName)), {
      locationName: row.locationName, locationType: ['swd', 'well', 'place'].includes(data.locationType) ? data.locationType : row.locationType, ...gps, radius: data.radius,
      sourceRequestId: id, approvedBy: staff.uid, approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { id, status };
  });
}

export const driverArrivalLocations = onCall({ region: 'us-central1' }, driverArrivalLocationsHandler);
export const reviewArrivalLocations = onCall({ region: 'us-central1' }, reviewArrivalLocationsHandler);
