import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { authorizeAdminCall } from '../admin/authority';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';

/** Read-only catalog. Operator scope comes exclusively from the company record. */
export const getDispatchLocationCatalog = https.onCall({ timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false }, async request => {
  if (!request.auth) throw new https.HttpsError('unauthenticated', 'Sign in to search locations.');
  const db = admin.firestore();
  const requested = typeof request.data?.companyId === 'string' ? request.data.companyId.trim() : '';
  if (!requested || !/^[a-zA-Z0-9_-]{1,128}$/.test(requested)) throw new https.HttpsError('invalid-argument', 'Select a company.');
  const record = await db.collection('platform_admins').doc(request.auth.uid).get();
  const platform = authorizeAdminCall(request.auth, record.exists ? record.data() : null);
  if (!platform.ok) {
    const trusted = await requireTrustedCompanyCapability(request.auth.uid, 'viewDispatch');
    if (trusted.companyId !== requested) throw new https.HttpsError('permission-denied', 'Company scope mismatch.');
  }
  const company = await db.collection('companies').doc(requested).get();
  if (!company.exists) throw new https.HttpsError('not-found', 'Company not found.');
  const operators: string[] = Array.isArray(company.data()?.assignedOperators) ? company.data()!.assignedOperators.filter((v: unknown): v is string => typeof v === 'string' && !!v.trim()) : [];
  const allowedFields = ['well_name', 'operator', 'api_no', 'latitude', 'longitude', 'legal_desc', 'county', 'field_name', 'search_name', 'search_operator', 'state'];
  const project = (data: Record<string, unknown>) => Object.fromEntries(allowedFields.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
  const [wellSnaps, disposals, customSnaps] = await Promise.all([
    Promise.all(operators.map(op => db.collection('wells').where('operator', '==', op).limit(20000).get())),
    db.collection('disposals').limit(10000).get(),
    Promise.all(operators.map(op => db.collection('customLocations').where('company', '==', op).limit(5000).get())),
  ]);
  return {
    companyId: requested,
    wells: wellSnaps.flatMap(s => s.docs.map(d => project(d.data()))),
    disposals: disposals.docs.map(d => project(d.data())),
    customLocations: customSnaps.flatMap(s => s.docs.map(d => {
      const c = d.data();
      return { locationName: c.locationName, company: c.company, latitude: c.latitude ?? null, longitude: c.longitude ?? null };
    })),
  };
});
