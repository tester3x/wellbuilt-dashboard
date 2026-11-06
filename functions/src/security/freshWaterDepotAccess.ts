import * as admin from 'firebase-admin';
import * as https from 'firebase-functions/v2/https';
import { authorizeAdminCall } from '../admin/authority';
import { writeSecurityAudit } from './audit';
import { decideTrustedCompanyCapability, TRUSTED_STAFF_AUTHORITY_COLLECTION } from './trustedStaffAuthority';

const companyIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const catalogIdPattern = /^nd-dwr:[0-9]+$/;

export const staffFreshWaterDepotAccess = https.onCall(async request => {
  const { auth, data } = request;
  if (!auth) throw new https.HttpsError('unauthenticated', 'Sign in to manage depot access.');

  const { companyId, catalogId, action } = data ?? {};
  if (typeof companyId !== 'string' || !companyIdPattern.test(companyId)
      || typeof catalogId !== 'string' || !catalogIdPattern.test(catalogId)
      || !['read', 'save', 'clear'].includes(action)) {
    throw new https.HttpsError('invalid-argument', 'Select a company and fresh water depot.');
  }
  if (auth.token.kind === 'driver' || companyId === 'wellbuilt-demo') {
    throw new https.HttpsError('permission-denied', 'Depot access is restricted to dispatch and admins.');
  }

  const db = admin.firestore();
  const [platformRecord, staffRecord] = await Promise.all([
    db.collection('platform_admins').doc(auth.uid).get(),
    db.collection(TRUSTED_STAFF_AUTHORITY_COLLECTION).doc(auth.uid).get(),
  ]);
  const isPlatformAdmin = authorizeAdminCall(auth, platformRecord.data()).ok;
  const hasCompanyAccess = ['createDispatch', 'manageCompany'].some(capability => {
    const scope = decideTrustedCompanyCapability(auth.uid, staffRecord.data(), capability);
    return scope.ok && scope.companyId === companyId;
  });
  if (!isPlatformAdmin && !hasCompanyAccess) {
    throw new https.HttpsError('permission-denied', 'Depot access is restricted to dispatch and admins.');
  }

  const depotId = catalogId.replace(':', '-');
  const [company, depot] = await Promise.all([
    db.collection('companies').doc(companyId).get(),
    db.collection('freshWaterDepots').doc(depotId).get(),
  ]);
  if (!company.exists || !depot.exists || depot.get('catalogId') !== catalogId || depot.get('source') !== 'ND DWR') {
    throw new https.HttpsError('not-found', 'Fresh water depot not found.');
  }

  // Server-only collection, covered by the rules catch-all deny. The public
  // depot document and its catalog projections never contain credentials.
  const access = db.collection('fresh_water_depot_access').doc(companyId).collection('depots').doc(depotId);
  if (action === 'read') {
    const record = await access.get();
    const login = record.get('login');
    const passcode = record.get('passcode');
    await writeSecurityAudit({ action: 'staffReadFreshWaterDepotAccess', actorUid: auth.uid,
      detail: { companyId, catalogId } });
    return { login: typeof login === 'string' ? login : '', passcode: typeof passcode === 'string' ? passcode : '' };
  }

  if (action === 'clear') {
    await access.delete();
  } else {
    const { login, passcode } = data;
    if (typeof login !== 'string' || typeof passcode !== 'string'
        || login.length > 128 || passcode.length > 128 || (!login.trim() && !passcode.trim())) {
      throw new https.HttpsError('invalid-argument', 'Enter a login or passcode up to 128 characters.');
    }
    await access.set({ login, passcode, updatedBy: auth.uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  await writeSecurityAudit({ action: action === 'clear' ? 'staffClearFreshWaterDepotAccess' : 'staffSaveFreshWaterDepotAccess',
    actorUid: auth.uid, detail: { companyId, catalogId } });
  return { ok: true };
});
