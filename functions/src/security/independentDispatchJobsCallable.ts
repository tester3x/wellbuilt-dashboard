import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { requireIndependentDispatchAuthority } from './independentDispatchAuthority';
import { hasIndependentDispatchPackage } from './operational/independentDispatchPackage';
import { assertIndependentJobMutable, independentJobTransition, parseIndependentJob, type IndependentJobStatus, type IndependentJobDetails } from './operational/independentDispatchJobs';
import { INDEPENDENT_SECTORS, parseIndependentSectors } from './operational/independentDispatchSectors';
import { driverAuthUid } from './tokenMint';

const COLLECTION = 'independent_dispatch_jobs';
const WB_DRIVER_LINKS = 'independent_dispatch_wb_drivers';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const KEYS = new Set(['op', 'jobId', 'job', 'expectedRevision', 'externalDriverId', 'wbDriverId', 'status', 'requestId', 'saveCustomer']);

/** Separate from governed WB-M execution: staff records dispatch progress, never tickets or driver acceptance. */
export const staffIndependentDispatchJobs = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const raw = request.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !KEYS.has(k)))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_request');
    const op = raw.op;
    if (!['list', 'create', 'update', 'assign', 'status'].includes(op))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_operation');
    const authority = await requireIndependentDispatchAuthority(request.auth?.uid, op === 'list' ? 'viewDispatch' : 'createDispatch');
    if (op === 'assign') await requireTrustedCompanyCapability(request.auth?.uid, 'manageDrivers');
    const db = admin.firestore();
    const companyRef = db.collection('companies').doc(authority.companyId);
    const company = await companyRef.get();
    if (!hasIndependentDispatchPackage(company.data()))
      throw new httpsV2.HttpsError('permission-denied', 'independent_dispatch_package_inactive');
    if (op === 'list') {
      const [snap, links] = await Promise.all([
        db.collection(COLLECTION).where('companyId', '==', authority.companyId).get(),
        companyRef.collection(WB_DRIVER_LINKS).where('companyId', '==', authority.companyId).get(),
      ]);
      return { ok: true, companyId: authority.companyId, jobs: snap.docs.map(d => ({ ...d.data(), id: d.id }))
        .sort((a, b) => String((b as any).updatedAt).localeCompare(String((a as any).updatedAt))),
        wbDrivers: links.docs.map(d => d.data()).filter(d => d.active === true && typeof d.driverId === 'string'
          && typeof d.sourceCompanyId === 'string' && typeof d.displayName === 'string')
          .map(d => ({ driverId: d.driverId, sourceCompanyId: d.sourceCompanyId, displayName: d.displayName })) };
    }
    if (typeof raw.jobId !== 'string' || !ID.test(raw.jobId) || typeof raw.requestId !== 'string' || !ID.test(raw.requestId))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_job_or_request_id');
    if (op !== 'create' && (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_revision');
    let details: IndependentJobDetails | undefined;
    try { if (op === 'create' || op === 'update') details = parseIndependentJob(raw.job); }
    catch (error) { throw new httpsV2.HttpsError('invalid-argument', (error as Error).message); }
    if (raw.saveCustomer !== undefined && (raw.saveCustomer !== true || op !== 'create' || !details?.sector || details.customerId))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_save_customer');
    let wbProfile: Record<string, unknown> | null = null;
    if (op === 'assign' && typeof raw.wbDriverId === 'string' && ID.test(raw.wbDriverId)) {
      const profile = await admin.database().ref(`drivers/profiles/${raw.wbDriverId}`).get();
      wbProfile = profile.val();
      let activeAuth = false;
      try { activeAuth = !(await admin.auth().getUser(driverAuthUid(raw.wbDriverId))).disabled; }
      catch { /* Missing or disabled account is not assignable. */ }
      if (!wbProfile || wbProfile.active !== true || !activeAuth)
        throw new httpsV2.HttpsError('failed-precondition', 'wellbuilt_driver_inactive');
    }
    const jobRef = db.collection(COLLECTION).doc(raw.jobId);
    const eventRef = jobRef.collection('events').doc(raw.requestId);
    return db.runTransaction(async tx => {
      const directoryConfigRef = companyRef.collection('independent_dispatch_config').doc('settings');
      const customerRef = details?.customerId ? companyRef.collection('independent_dispatch_customers').doc(details.customerId) : null;
      const newCustomerRef = raw.saveCustomer === true ? companyRef.collection('independent_dispatch_customers').doc(`job_${raw.jobId}`) : null;
      const [jobSnap, eventSnap, freshCompany, directoryConfig, customer, newCustomer] = await Promise.all([
        tx.get(jobRef), tx.get(eventRef), tx.get(companyRef),
        details?.sector ? tx.get(directoryConfigRef) : Promise.resolve(null),
        customerRef ? tx.get(customerRef) : Promise.resolve(null),
        newCustomerRef ? tx.get(newCustomerRef) : Promise.resolve(null),
      ]);
      if (!hasIndependentDispatchPackage(freshCompany.data()))
        throw new httpsV2.HttpsError('permission-denied', 'independent_dispatch_package_inactive');
      if (details?.sector) {
        const enabled = directoryConfig?.exists ? parseIndependentSectors(directoryConfig.data()?.sectors) : [...INDEPENDENT_SECTORS];
        if (!enabled.includes(details.sector as typeof INDEPENDENT_SECTORS[number]))
          throw new httpsV2.HttpsError('failed-precondition', 'sector_disabled');
        if (customerRef) {
          if (!customer?.exists || customer.data()?.companyId !== authority.companyId
            || customer.data()?.active !== true || !Array.isArray(customer.data()?.sectors)
            || !customer.data()!.sectors.includes(details.sector))
            throw new httpsV2.HttpsError('failed-precondition', 'customer_sector_unavailable');
          details.customer = customer.data()!.name;
        }
      }
      const previous = jobSnap.data();
      if (previous && previous.companyId !== authority.companyId)
        throw new httpsV2.HttpsError('permission-denied', 'cross_company');
      // Idempotency includes the exact payload: retries cannot reuse a key for different work.
      const payload = JSON.stringify({ op, job: details ?? null, expectedRevision: raw.expectedRevision ?? null,
        externalDriverId: raw.externalDriverId ?? null, wbDriverId: raw.wbDriverId ?? null, status: raw.status ?? null });
      if (eventSnap.exists) {
        if (eventSnap.data()?.companyId !== authority.companyId || eventSnap.data()?.payload !== payload)
          throw new httpsV2.HttpsError('already-exists', 'request_conflict');
        return { ok: true, idempotent: true, job: { ...previous, id: jobSnap.id } };
      }
      if (op === 'create' && previous) throw new httpsV2.HttpsError('already-exists', 'job_exists');
      if (newCustomer?.exists) throw new httpsV2.HttpsError('already-exists', 'customer_exists');
      if (op !== 'create' && !previous) throw new httpsV2.HttpsError('not-found', 'job_not_found');
      if (previous && previous.revision !== raw.expectedRevision)
        throw new httpsV2.HttpsError('failed-precondition', 'job_changed_refresh_before_retry');
      const now = new Date().toISOString();
      let patch: Record<string, unknown> = details ? { ...details } : {};
      if (newCustomerRef && details?.sector) {
        tx.create(newCustomerRef, { companyId: authority.companyId, name: details.customer, alternateNames: [],
          phoneE164: '', sectors: [details.sector], jobNames: [], pickupLocations: [], deliveryLocations: [],
          active: true, updatedAt: now, updatedBy: authority.uid });
        patch.customerId = newCustomerRef.id;
      }
      if (op === 'update' || op === 'assign') {
        try { assertIndependentJobMutable(previous!.status); }
        catch { throw new httpsV2.HttpsError('failed-precondition', 'job_not_editable'); }
      }
      if (op === 'assign') {
        const wantsExternal = raw.externalDriverId !== undefined;
        const wantsWellBuilt = raw.wbDriverId !== undefined;
        if (wantsExternal === wantsWellBuilt) throw new httpsV2.HttpsError('invalid-argument', 'choose_one_driver');
        const external = typeof raw.externalDriverId === 'string' && ID.test(raw.externalDriverId);
        const wellbuilt = typeof raw.wbDriverId === 'string' && ID.test(raw.wbDriverId);
        if (!external && !wellbuilt) throw new httpsV2.HttpsError('invalid-argument', 'invalid_driver');
        if (external) {
          const driver = await tx.get(companyRef.collection('external_drivers').doc(raw.externalDriverId));
          if (!driver.exists || driver.data()?.companyId !== authority.companyId || driver.data()?.active !== true)
            throw new httpsV2.HttpsError('failed-precondition', 'external_driver_inactive');
          patch = { externalDriverId: raw.externalDriverId, wbDriverId: '', wbDriverCompanyId: '',
            driverSource: 'outside', driverName: driver.data()!.displayName, status: 'assigned' };
        } else {
          const link = await tx.get(companyRef.collection(WB_DRIVER_LINKS).doc(raw.wbDriverId));
          const data = link.data();
          if (!link.exists || data?.companyId !== authority.companyId || data?.driverId !== raw.wbDriverId
            || data?.active !== true || data?.authUid !== driverAuthUid(raw.wbDriverId)
            || data?.sourceCompanyId !== wbProfile?.companyId || typeof data?.displayName !== 'string')
            throw new httpsV2.HttpsError('failed-precondition', 'wellbuilt_driver_not_linked');
          patch = { externalDriverId: '', wbDriverId: raw.wbDriverId, wbDriverCompanyId: data.sourceCompanyId,
            driverSource: 'wellbuilt', driverName: data.displayName, status: 'assigned' };
        }
      }
      if (op === 'status') {
        if (!independentJobTransition(previous!.status, raw.status as IndependentJobStatus))
          throw new httpsV2.HttpsError('failed-precondition', 'invalid_job_transition');
        patch = { status: raw.status, ...(raw.status === 'completed' ? { completedAt: now } : {}) };
      }
      const job = { ...previous, ...patch,
        ...(op === 'create' ? { companyId: authority.companyId, packageId: 'independent-dispatch', status: 'unassigned', createdAt: now, createdBy: authority.uid } : {}),
        revision: (previous?.revision || 0) + 1, updatedAt: now, updatedBy: authority.uid };
      tx.set(jobRef, job);
      tx.create(eventRef, { companyId: authority.companyId, op, payload, actorUid: authority.uid, at: now,
        revision: job.revision, fromStatus: previous?.status ?? null, toStatus: job.status });
      return { ok: true, idempotent: false, job: { ...job, id: jobSnap.id } };
    });
  },
);
