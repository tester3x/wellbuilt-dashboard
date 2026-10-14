import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { applyDispatchSwdDirectory } from './dispatchSwdDirectory';
import { authorizeAdminCall } from '../admin/authority';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { DEMO_COMPANY_ID } from '../liveDemo/runtime';

/** Read-only catalog. Operator scope comes exclusively from the company record. */
export const getDispatchLocationCatalog = https.onCall({ timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false }, async request => {
  if (!request.auth) throw new https.HttpsError('unauthenticated', 'Sign in to search locations.');
  const db = admin.firestore();
  const requested = typeof request.data?.companyId === 'string' ? request.data.companyId.trim() : '';
  if (!requested || !/^[a-zA-Z0-9_-]{1,128}$/.test(requested)) throw new https.HttpsError('invalid-argument', 'Select a company.');
  const demoViewer = request.auth.uid === 'wellbuilt-demo-shared-viewer'
    && request.auth.token.staffRole === 'demo_viewer'
    && request.auth.token.staffCompanyId === DEMO_COMPANY_ID
    && request.auth.token.isDemo === true;
  if (demoViewer) {
    if (requested !== DEMO_COMPANY_ID) throw new https.HttpsError('permission-denied', 'Company scope mismatch.');
    const [wellSnap, directory] = await Promise.all([
      admin.database().ref('well_config').once('value'),
      db.collection('companies').doc(DEMO_COMPANY_ID).collection('swd_directory').get(),
    ]);
    const wellRows = Object.entries((wellSnap.val() || {}) as Record<string, Record<string, unknown>>)
      .filter(([, value]) => value?.companyId === DEMO_COMPANY_ID)
      .map(([key, value]) => ({
        well_name: String(value.name || key), operator: String(value.operator || 'Demo Operator'),
        api_no: '', latitude: null, longitude: null,
      }));
    return {
      companyId: DEMO_COMPANY_ID,
      wells: wellRows,
      disposals: directory.docs.filter(doc => doc.get('isCustom') === true && doc.get('isBlacklisted') !== true).map(doc => ({
        well_name: String(doc.get('displayName') || doc.get('well_name') || doc.get('name') || doc.id),
        operator: String(doc.get('operator') || 'Demo Operator'),
        api_no: '', latitude: null, longitude: null,
      })),
      customLocations: [],
    };
  }
  const record = await db.collection('platform_admins').doc(request.auth.uid).get();
  const platform = authorizeAdminCall(request.auth, record.exists ? record.data() : null);
  if (!platform.ok) {
    // Demo admin is deliberately provisioned with demo-scoped manageDrivers
    // authority so it can dispatch jobs without broader platform access.
    const capability = requested === DEMO_COMPANY_ID ? 'manageDrivers' : 'viewDispatch';
    const trusted = await requireTrustedCompanyCapability(request.auth.uid, capability);
    if (trusted.companyId !== requested) throw new https.HttpsError('permission-denied', 'Company scope mismatch.');
  }
  const company = await db.collection('companies').doc(requested).get();
  if (!company.exists) throw new https.HttpsError('not-found', 'Company not found.');
  const operators: string[] = Array.isArray(company.data()?.assignedOperators) ? company.data()!.assignedOperators.filter((v: unknown): v is string => typeof v === 'string' && !!v.trim()) : [];
  const allowedFields = ['well_name', 'operator', 'api_no', 'latitude', 'longitude', 'legal_desc', 'county', 'field_name', 'search_name', 'search_operator', 'state'];
  const project = (data: Record<string, unknown>) => Object.fromEntries(allowedFields.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
  const [wellSnaps, disposals, customSnaps, directory] = await Promise.all([
    Promise.all(operators.map(op => db.collection('wells').where('operator', '==', op).limit(20000).get())),
    db.collection('disposals').limit(10000).get(),
    Promise.all(operators.map(op => db.collection('customLocations').where('company', '==', op).limit(5000).get())),
    db.collection('companies').doc(requested).collection('swd_directory').limit(5000).get(),
  ]);
  return {
    companyId: requested,
    wells: wellSnaps.flatMap(s => s.docs.map(d => project(d.data()))),
    disposals: applyDispatchSwdDirectory(disposals.docs.map(d => project(d.data())), directory.docs.map(d => d.data())),
    customLocations: customSnaps.flatMap(s => s.docs.map(d => {
      const c = d.data();
      return { locationName: c.locationName, company: c.company, usageCount: typeof c.usageCount === 'number' ? c.usageCount : 0, latitude: c.latitude ?? null, longitude: c.longitude ?? null };
    })),
  };
});
