import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { requireIndependentDispatchAuthority } from './independentDispatchAuthority';
import { hasIndependentDispatchPackage } from './operational/independentDispatchPackage';
import { assertIndependentJobMutable, independentJobTransition, parseIndependentJob, type IndependentJobStatus, type IndependentJobDetails } from './operational/independentDispatchJobs';
import { INDEPENDENT_SECTORS, parseIndependentSectors } from './operational/independentDispatchSectors';
import { driverAuthUid } from './tokenMint';
import { assignedDriverKeys, hasDriverAssignmentConflict } from './operational/independentDriverAvailability';

const COLLECTION = 'independent_dispatch_jobs';
const WB_DRIVER_LINKS = 'independent_dispatch_wb_drivers';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const normalizeCustomerName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const KEYS = new Set(['op', 'jobId', 'job', 'expectedRevision', 'externalDriverId', 'wbDriverId', 'driverKey', 'drivers', 'shift', 'status', 'requestId', 'saveCustomer']);
type JobDriver = { key: string; name: string; source: 'outside' | 'wellbuilt'; companyId?: string; shift: '' | 'day' | 'night'; assignedAt: string };
type DriverSelection = { key: string; shift: '' | 'day' | 'night' };
function jobDrivers(job: Record<string, any> | undefined): JobDriver[] {
  if (Array.isArray(job?.drivers)) return job.drivers;
  const shift = job?.shift === 'day' || job?.shift === 'night' ? job.shift : '';
  if (job?.externalDriverId) return [{ key: `outside:${job.externalDriverId}`, name: job.driverName || '', source: 'outside', shift, assignedAt: job.updatedAt || '' }];
  if (job?.wbDriverId) return [{ key: `wellbuilt:${job.wbDriverId}`, name: job.driverName || '', source: 'wellbuilt', companyId: job.wbDriverCompanyId || '', shift, assignedAt: job.updatedAt || '' }];
  return [];
}

/** Separate from governed WB-M execution: staff records dispatch progress, never tickets or driver acceptance. */
export const staffIndependentDispatchJobs = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const raw = request.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !KEYS.has(k)))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_request');
    const op = raw.op;
    if (!['list', 'create', 'update', 'assign', 'addDriver', 'addDrivers', 'replaceDriver', 'removeDriver', 'setDriverShift', 'status', 'markWhatsAppSent'].includes(op))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_operation');
    if (raw.drivers !== undefined && op !== 'addDrivers')
      throw new httpsV2.HttpsError('invalid-argument', 'unexpected_drivers');
    const authority = await requireIndependentDispatchAuthority(request.auth?.uid, op === 'list' ? 'viewDispatch' : 'createDispatch');
    if (['assign', 'addDriver', 'addDrivers', 'replaceDriver', 'removeDriver', 'setDriverShift'].includes(op)) await requireTrustedCompanyCapability(request.auth?.uid, 'manageDrivers');
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
        wbDrivers: links.docs.map(d => d.data()).filter(d => typeof d.active === 'boolean' && typeof d.driverId === 'string'
          && typeof d.sourceCompanyId === 'string' && typeof d.displayName === 'string')
          .map(d => ({ driverId: d.driverId, sourceCompanyId: d.sourceCompanyId, displayName: d.displayName, active: d.active })) };
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
    let selectedDrivers: DriverSelection[] = [];
    if (op === 'addDrivers') {
      if (raw.externalDriverId !== undefined || raw.wbDriverId !== undefined || raw.driverKey !== undefined || raw.shift !== undefined
        || !Array.isArray(raw.drivers) || raw.drivers.length < 1 || raw.drivers.length > 30)
        throw new httpsV2.HttpsError('invalid-argument', 'invalid_driver_selection');
      const seen = new Set<string>();
      selectedDrivers = raw.drivers.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new httpsV2.HttpsError('invalid-argument', 'invalid_driver_selection');
        const driver = entry as Record<string, unknown>;
        if (Object.keys(driver).some(key => !['key', 'shift'].includes(key))
          || typeof driver.key !== 'string' || !/^(outside|wellbuilt):[A-Za-z0-9_-]{1,100}$/.test(driver.key)
          || seen.has(driver.key) || !['', 'day', 'night'].includes(driver.shift as string))
          throw new httpsV2.HttpsError('invalid-argument', 'invalid_driver_selection');
        seen.add(driver.key);
        return { key: driver.key, shift: driver.shift as DriverSelection['shift'] };
      });
    }
    let wbProfile: Record<string, unknown> | null = null;
    if (['assign', 'addDriver', 'replaceDriver'].includes(op) && typeof raw.wbDriverId === 'string' && ID.test(raw.wbDriverId)) {
      const profile = await admin.database().ref(`drivers/profiles/${raw.wbDriverId}`).get();
      wbProfile = profile.val();
      let activeAuth = false;
      try { activeAuth = !(await admin.auth().getUser(driverAuthUid(raw.wbDriverId))).disabled; }
      catch { /* Missing or disabled account is not assignable. */ }
      if (!wbProfile || wbProfile.active !== true || !activeAuth)
        throw new httpsV2.HttpsError('failed-precondition', 'wellbuilt_driver_inactive');
    }
    const wbProfiles = new Map<string, Record<string, unknown>>();
    await Promise.all(selectedDrivers.filter(driver => driver.key.startsWith('wellbuilt:')).map(async driver => {
      const id = driver.key.slice(10);
      const profile = (await admin.database().ref(`drivers/profiles/${id}`).get()).val();
      let activeAuth = false;
      try { activeAuth = !(await admin.auth().getUser(driverAuthUid(id))).disabled; }
      catch { /* Missing or disabled account is not assignable. */ }
      if (!profile || profile.active !== true || !activeAuth)
        throw new httpsV2.HttpsError('failed-precondition', 'wellbuilt_driver_inactive');
      wbProfiles.set(id, profile);
    }));
    const jobRef = db.collection(COLLECTION).doc(raw.jobId);
    const eventRef = jobRef.collection('events').doc(raw.requestId);
    return db.runTransaction(async tx => {
      const directoryConfigRef = companyRef.collection('independent_dispatch_config').doc('settings');
      const customerRef = details?.customerId ? companyRef.collection('independent_dispatch_customers').doc(details.customerId) : null;
      const newCustomerRef = raw.saveCustomer === true ? companyRef.collection('independent_dispatch_customers').doc(`job_${raw.jobId}`) : null;
      const [jobSnap, eventSnap, freshCompany, directoryConfig, customer, newCustomer, otherCustomers, otherJobs] = await Promise.all([
        tx.get(jobRef), tx.get(eventRef), tx.get(companyRef),
        details?.sector ? tx.get(directoryConfigRef) : Promise.resolve(null),
        customerRef ? tx.get(customerRef) : Promise.resolve(null),
        newCustomerRef ? tx.get(newCustomerRef) : Promise.resolve(null),
        newCustomerRef ? tx.get(companyRef.collection('independent_dispatch_customers').limit(500)) : Promise.resolve(null),
        ['assign', 'addDriver', 'addDrivers', 'replaceDriver', 'update'].includes(op) ? tx.get(db.collection(COLLECTION).where('companyId', '==', authority.companyId)) : Promise.resolve(null),
      ]);
      if (!hasIndependentDispatchPackage(freshCompany.data()))
        throw new httpsV2.HttpsError('permission-denied', 'independent_dispatch_package_inactive');
      const previous = jobSnap.data();
      if (previous && previous.companyId !== authority.companyId)
        throw new httpsV2.HttpsError('permission-denied', 'cross_company');
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
          if (details.categoryId) {
            const category = Array.isArray(customer.data()!.workCategories)
              ? customer.data()!.workCategories.find((entry: any) => entry?.id === details!.categoryId && entry?.sector === details!.sector)
              : null;
            const unchangedArchivedCategory = op === 'update' && previous?.customerId === details.customerId
              && previous?.sector === details.sector && previous?.categoryId === details.categoryId;
            if ((!category || typeof category.name !== 'string') && !unchangedArchivedCategory)
              throw new httpsV2.HttpsError('failed-precondition', 'customer_category_unavailable');
          }
        }
      }
      // Idempotency includes the exact payload: retries cannot reuse a key for different work.
      const payload = JSON.stringify({ op, job: details ?? null, expectedRevision: raw.expectedRevision ?? null,
        externalDriverId: raw.externalDriverId ?? null, wbDriverId: raw.wbDriverId ?? null,
        driverKey: raw.driverKey ?? null, ...(op === 'addDrivers' ? { drivers: selectedDrivers } : {}),
        shift: raw.shift ?? null, status: raw.status ?? null });
      if (eventSnap.exists) {
        if (eventSnap.data()?.companyId !== authority.companyId || eventSnap.data()?.payload !== payload)
          throw new httpsV2.HttpsError('already-exists', 'request_conflict');
        return { ok: true, idempotent: true, job: { ...previous, id: jobSnap.id } };
      }
      if (op === 'create' && previous) throw new httpsV2.HttpsError('already-exists', 'job_exists');
      if (newCustomer?.exists) throw new httpsV2.HttpsError('already-exists', 'customer_exists');
      if (newCustomerRef && otherCustomers?.docs.some(doc => doc.id !== newCustomerRef.id
        && doc.data().companyId === authority.companyId && doc.data().active !== false
        && [doc.data().name, ...(Array.isArray(doc.data().alternateNames) ? doc.data().alternateNames : [])]
          .some((name: unknown) => typeof name === 'string'
            && normalizeCustomerName(name) === normalizeCustomerName(details!.customer))))
        throw new httpsV2.HttpsError('failed-precondition', 'customer_name_conflict');
      if (op !== 'create' && !previous) throw new httpsV2.HttpsError('not-found', 'job_not_found');
      if (previous && previous.revision !== raw.expectedRevision)
        throw new httpsV2.HttpsError('failed-precondition', 'job_changed_refresh_before_retry');
      const now = new Date().toISOString();
      let patch: Record<string, unknown> = details ? { ...details } : {};
      if (newCustomerRef && details?.sector) {
        tx.create(newCustomerRef, { companyId: authority.companyId, name: details.customer, alternateNames: [],
          phoneE164: '', sectors: [details.sector],
          contacts: details.jobContactName ? [{ id: `contact_${raw.jobId}`.slice(0, 100), name: details.jobContactName,
            role: details.jobContactRole || '', phoneE164: details.jobContactPhoneE164 || '' }] : [],
          jobNames: [], pickupLocations: [], deliveryLocations: [],
          workCategories: [],
          active: true, updatedAt: now, updatedBy: authority.uid });
        patch.customerId = newCustomerRef.id;
      }
      if (op === 'update' || op === 'assign') {
        try { assertIndependentJobMutable(previous!.status); }
        catch { throw new httpsV2.HttpsError('failed-precondition', 'job_not_editable'); }
      }
      if (['assign', 'addDriver', 'addDrivers', 'replaceDriver', 'removeDriver'].includes(op)) {
        if (!['assigned', 'in_progress'].includes(previous!.status) && op !== 'assign' && op !== 'addDriver' && op !== 'addDrivers')
          throw new httpsV2.HttpsError('failed-precondition', 'job_has_no_drivers');
        if (['completed', 'cancelled'].includes(previous!.status))
          throw new httpsV2.HttpsError('failed-precondition', 'job_not_editable');
        if (['addDriver', 'addDrivers'].includes(op) && previous!.status === 'unassigned' && jobDrivers(previous).length)
          throw new httpsV2.HttpsError('failed-precondition', 'invalid_job_state');
        if (['replaceDriver', 'removeDriver'].includes(op) && (typeof raw.driverKey !== 'string' || !/^(outside|wellbuilt):[A-Za-z0-9_-]{1,100}$/.test(raw.driverKey)
          || !assignedDriverKeys(previous!).includes(raw.driverKey)))
          throw new httpsV2.HttpsError('invalid-argument', 'driver_not_on_job');
      }
      if (op === 'setDriverShift' && (!['assigned', 'in_progress'].includes(previous!.status)
        || typeof raw.driverKey !== 'string' || !assignedDriverKeys(previous!).includes(raw.driverKey)
        || !['day', 'night'].includes(raw.shift)))
        throw new httpsV2.HttpsError('failed-precondition', 'invalid_driver_shift_change');
      if (op === 'markWhatsAppSent' && (!['assigned', 'in_progress'].includes(previous!.status)
        || typeof raw.driverKey !== 'string' || !assignedDriverKeys(previous!).includes(raw.driverKey)))
        throw new httpsV2.HttpsError('failed-precondition', 'driver_not_on_active_job');
      if (['assign', 'addDriver', 'replaceDriver'].includes(op)) {
        const wantsExternal = raw.externalDriverId !== undefined;
        const wantsWellBuilt = raw.wbDriverId !== undefined;
        if (wantsExternal === wantsWellBuilt) throw new httpsV2.HttpsError('invalid-argument', 'choose_one_driver');
        const external = typeof raw.externalDriverId === 'string' && ID.test(raw.externalDriverId);
        const wellbuilt = typeof raw.wbDriverId === 'string' && ID.test(raw.wbDriverId);
        if (!external && !wellbuilt) throw new httpsV2.HttpsError('invalid-argument', 'invalid_driver');
        if (raw.shift !== undefined && !['', 'day', 'night'].includes(raw.shift))
          throw new httpsV2.HttpsError('invalid-argument', 'invalid_driver_shift');
        const key = external ? `outside:${raw.externalDriverId}` : `wellbuilt:${raw.wbDriverId}`;
        const existing = jobDrivers(previous);
        if (op === 'assign' && existing.length > 1)
          throw new httpsV2.HttpsError('failed-precondition', 'use_crew_assignment');
        if (op !== 'assign' && existing.some(driver => driver.key === key && driver.key !== raw.driverKey))
          throw new httpsV2.HttpsError('already-exists', 'driver_already_on_job');
        if (op === 'addDriver' && existing.length >= 30)
          throw new httpsV2.HttpsError('failed-precondition', 'job_driver_limit');
        let nextDriver: JobDriver;
        if (external) {
          const driver = await tx.get(companyRef.collection('external_drivers').doc(raw.externalDriverId));
          if (!driver.exists || driver.data()?.companyId !== authority.companyId || driver.data()?.active !== true)
            throw new httpsV2.HttpsError('failed-precondition', 'external_driver_inactive');
          nextDriver = { key, name: driver.data()!.displayName, source: 'outside', shift: (raw.shift ?? existing.find(driver => driver.key === raw.driverKey)?.shift ?? (previous?.shift === 'day' || previous?.shift === 'night' ? previous.shift : '')) as JobDriver['shift'], assignedAt: now };
        } else {
          const link = await tx.get(companyRef.collection(WB_DRIVER_LINKS).doc(raw.wbDriverId));
          const data = link.data();
          if (!link.exists || data?.companyId !== authority.companyId || data?.driverId !== raw.wbDriverId
            || data?.active !== true || data?.authUid !== driverAuthUid(raw.wbDriverId)
            || data?.sourceCompanyId !== wbProfile?.companyId || typeof data?.displayName !== 'string')
            throw new httpsV2.HttpsError('failed-precondition', 'wellbuilt_driver_not_linked');
          nextDriver = { key, name: data.displayName, source: 'wellbuilt', companyId: data.sourceCompanyId,
            shift: (raw.shift ?? existing.find(driver => driver.key === raw.driverKey)?.shift ?? (previous?.shift === 'day' || previous?.shift === 'night' ? previous.shift : '')) as JobDriver['shift'], assignedAt: now };
        }
        const nextDrivers = op === 'assign' ? [nextDriver] : op === 'replaceDriver'
          ? existing.map(driver => driver.key === raw.driverKey ? nextDriver : driver) : [...existing, nextDriver];
        const primary = nextDrivers[0];
        patch = { drivers: nextDrivers, externalDriverId: primary.source === 'outside' ? primary.key.slice(8) : '',
          wbDriverId: primary.source === 'wellbuilt' ? primary.key.slice(10) : '', wbDriverCompanyId: primary.companyId || '',
          driverSource: primary.source, driverName: primary.name,
          status: previous!.status === 'unassigned' ? 'assigned' : previous!.status };
      }
      if (op === 'addDrivers') {
        const existing = jobDrivers(previous);
        if (existing.length + selectedDrivers.length > 30)
          throw new httpsV2.HttpsError('failed-precondition', 'job_driver_limit');
        if (selectedDrivers.some(driver => existing.some(member => member.key === driver.key)))
          throw new httpsV2.HttpsError('already-exists', 'driver_already_on_job');
        const snapshots = await Promise.all(selectedDrivers.map(driver => {
          const [source, id] = driver.key.split(':');
          return tx.get(companyRef.collection(source === 'outside' ? 'external_drivers' : WB_DRIVER_LINKS).doc(id));
        }));
        const added: JobDriver[] = selectedDrivers.map((driver, index) => {
          const [source, id] = driver.key.split(':');
          const data = snapshots[index].data();
          if (source === 'outside') {
            if (!snapshots[index].exists || data?.companyId !== authority.companyId || data?.active !== true
              || typeof data?.displayName !== 'string')
              throw new httpsV2.HttpsError('failed-precondition', 'external_driver_inactive');
            return { key: driver.key, name: data.displayName, source: 'outside', shift: driver.shift, assignedAt: now };
          }
          if (!snapshots[index].exists || data?.companyId !== authority.companyId || data?.driverId !== id
            || data?.active !== true || data?.authUid !== driverAuthUid(id)
            || data?.sourceCompanyId !== wbProfiles.get(id)?.companyId || typeof data?.displayName !== 'string')
            throw new httpsV2.HttpsError('failed-precondition', 'wellbuilt_driver_not_linked');
          return { key: driver.key, name: data.displayName, source: 'wellbuilt', companyId: data.sourceCompanyId,
            shift: driver.shift, assignedAt: now };
        });
        const nextDrivers = [...existing, ...added];
        const primary = nextDrivers[0];
        patch = { drivers: nextDrivers, externalDriverId: primary.source === 'outside' ? primary.key.slice(8) : '',
          wbDriverId: primary.source === 'wellbuilt' ? primary.key.slice(10) : '', wbDriverCompanyId: primary.companyId || '',
          driverSource: primary.source, driverName: primary.name,
          status: previous!.status === 'unassigned' ? 'assigned' : previous!.status };
      }
      if (op === 'removeDriver') {
        const nextDrivers = jobDrivers(previous).filter(driver => driver.key !== raw.driverKey);
        if (!nextDrivers.length && previous!.status === 'in_progress')
          throw new httpsV2.HttpsError('failed-precondition', 'replace_last_active_driver');
        const primary = nextDrivers[0];
        patch = { drivers: nextDrivers, externalDriverId: primary?.source === 'outside' ? primary.key.slice(8) : '',
          wbDriverId: primary?.source === 'wellbuilt' ? primary.key.slice(10) : '', wbDriverCompanyId: primary?.companyId || '',
          driverSource: primary?.source || '', driverName: primary?.name || '', status: primary ? previous!.status : 'unassigned' };
      }
      if (op === 'setDriverShift') {
        patch = { drivers: jobDrivers(previous).map(driver => driver.key === raw.driverKey
          ? { ...driver, shift: raw.shift } : driver) };
      }
      if (op === 'status') {
        if (!independentJobTransition(previous!.status, raw.status as IndependentJobStatus))
          throw new httpsV2.HttpsError('failed-precondition', 'invalid_job_transition');
        patch = { status: raw.status, ...(raw.status === 'completed' ? { completedAt: now } : {}) };
      }
      if (op === 'markWhatsAppSent') {
        const sent = Array.isArray(previous!.whatsappSent) ? previous!.whatsappSent.filter((entry: any) =>
          typeof entry?.driverKey === 'string' && entry.driverKey !== raw.driverKey) : [];
        patch = { whatsappSent: [...sent, { driverKey: raw.driverKey, sentAt: now, sentBy: authority.uid }] };
      }
      if (['assign', 'addDriver', 'addDrivers', 'replaceDriver', 'update'].includes(op)) {
        const candidate = { ...previous, ...patch, id: jobRef.id };
        const keysToCheck = op === 'update' ? assignedDriverKeys(candidate)
          : op === 'addDrivers' ? selectedDrivers.map(driver => driver.key)
          : [typeof raw.externalDriverId === 'string' ? `outside:${raw.externalDriverId}` : `wellbuilt:${raw.wbDriverId}`];
        for (const key of keysToCheck) {
          if (hasDriverAssignmentConflict(candidate, key, otherJobs?.docs.map(doc => ({ ...doc.data(), id: doc.id })) || []))
            throw new httpsV2.HttpsError('failed-precondition', 'driver_assignment_conflict');
        }
      }
      const job = { ...previous, ...patch,
        ...(op === 'create' ? { companyId: authority.companyId, packageId: 'independent-dispatch', status: 'unassigned', createdAt: now, createdBy: authority.uid } : {}),
        revision: (previous?.revision || 0) + 1, updatedAt: now, updatedBy: authority.uid };
      tx.set(jobRef, job);
      tx.create(eventRef, { companyId: authority.companyId, op, payload, actorUid: authority.uid, at: now,
        revision: job.revision, fromStatus: previous?.status ?? null, toStatus: job.status,
        beforeDrivers: jobDrivers(previous).map(driver => ({ key: driver.key, shift: driver.shift })),
        afterDrivers: jobDrivers(job).map(driver => ({ key: driver.key, shift: driver.shift })) });
      return { ok: true, idempotent: false, job: { ...job, id: jobSnap.id } };
    });
  },
);
