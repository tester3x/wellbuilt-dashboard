import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireIndependentDispatchAuthority } from './independentDispatchAuthority';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { hasIndependentDispatchPackage } from './operational/independentDispatchPackage';
import { parseIndependentDriverProfile, profileDocumentId } from './operational/independentDriverProfiles';

/** Driver work context and operator review notes. No assignment restriction is inferred from these records. */
export const staffIndependentDriverProfiles = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const raw = request.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !['op', 'profile', 'expectedRevision'].includes(key))
      || !['list', 'save'].includes(raw.op))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_driver_profile_request');
    const [viewer, manager] = await Promise.all([
      requireIndependentDispatchAuthority(request.auth?.uid, 'viewDispatch'),
      requireTrustedCompanyCapability(request.auth?.uid, 'manageDrivers'),
    ]);
    if (viewer.companyId !== manager.companyId) throw new httpsV2.HttpsError('permission-denied', 'company_mismatch');
    const db = admin.firestore();
    const companyRef = db.collection('companies').doc(manager.companyId);
    const company = await companyRef.get();
    if (!hasIndependentDispatchPackage(company.data()))
      throw new httpsV2.HttpsError('permission-denied', 'independent_dispatch_package_inactive');
    const profilesRef = companyRef.collection('independent_dispatch_driver_profiles');
    if (raw.op === 'list') {
      if (Object.keys(raw).length !== 1) throw new httpsV2.HttpsError('invalid-argument', 'unexpected_driver_profile_fields');
      const snap = await profilesRef.limit(500).get();
      return { ok: true, companyId: manager.companyId, profiles: snap.docs.map(doc => doc.data())
        .filter(profile => profile.companyId === manager.companyId) };
    }
    if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0)
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_driver_profile_revision');
    let profile;
    try { profile = parseIndependentDriverProfile(raw.profile); }
    catch (error) { throw new httpsV2.HttpsError('invalid-argument', (error as Error).message); }
    const documentId = profileDocumentId(profile.driverKey);
    const [source, driverId] = profile.driverKey.split(':');
    const driverRef = companyRef.collection(source === 'outside' ? 'external_drivers' : 'independent_dispatch_wb_drivers').doc(driverId);
    const customerIds = [...new Set([profile.primaryCustomerId, ...profile.operatorNotes.map(note => note.customerId)].filter(Boolean))];
    const ref = profilesRef.doc(documentId);
    return db.runTransaction(async tx => {
      const [existing, driver, ...customers] = await Promise.all([
        tx.get(ref), tx.get(driverRef), ...customerIds.map(id => tx.get(companyRef.collection('independent_dispatch_customers').doc(id))),
      ]);
      if (!driver.exists || driver.data()?.companyId !== manager.companyId
        || (source === 'outside' ? driver.data()?.externalDriverId !== driverId : driver.data()?.driverId !== driverId))
        throw new httpsV2.HttpsError('failed-precondition', 'driver_not_in_company_roster');
      if (customers.some(snap => !snap.exists || snap.data()?.companyId !== manager.companyId || snap.data()?.active !== true))
        throw new httpsV2.HttpsError('failed-precondition', 'customer_not_in_company_directory');
      const previous = existing.data();
      if (previous && previous.companyId !== manager.companyId) throw new httpsV2.HttpsError('permission-denied', 'cross_company');
      const revision = Number.isSafeInteger(previous?.revision) ? Number(previous?.revision) : 0;
      if (revision !== raw.expectedRevision)
        throw new httpsV2.HttpsError('failed-precondition', 'driver_profile_changed_refresh_before_retry');
      const now = new Date().toISOString();
      const next = { ...profile, companyId: manager.companyId, revision: revision + 1,
        updatedAt: now, updatedBy: manager.uid };
      tx.set(ref, next);
      tx.create(ref.collection('revisions').doc(String(next.revision)), {
        companyId: manager.companyId, driverKey: profile.driverKey, revision: next.revision,
        previous: previous || null, next, at: now, actorUid: manager.uid,
      });
      return { ok: true, profile: next };
    });
  },
);
