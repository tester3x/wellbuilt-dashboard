import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { applyDispatchSwdDirectory } from './dispatchSwdDirectory';
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
  const [wellSnaps, disposals, customSnaps, directory] = await Promise.all([
    Promise.all(operators.map(op => db.collection('wells').where('operator', '==', op).limit(20000).get())),
    db.collection('disposals').limit(10000).get(),
    Promise.all(operators.map(op => db.collection('customLocations').where('company', '==', op).limit(5000).get())),
    db.collection('companies').doc(requested).collection('swd_directory').limit(5000).get(),
  ]);
  const custom=customSnaps.flatMap(s=>s.docs.map(d=>d.data())).filter(p=>p.ndicInactiveApproved!==true || p.companyId===requested);
  const wells=wellSnaps.flatMap(s=>s.docs.map(d=>project(d.data())));
  const seen=new Set(wells.map(w=>w.api_no));
  for(const p of custom){if(p.ndicInactiveApproved===true&&p.api_no&&!seen.has(p.api_no)){wells.push(project({well_name:p.locationName,operator:p.company,api_no:p.api_no,latitude:p.latitude,longitude:p.longitude,state:'ND'}));seen.add(p.api_no);}}
  return {
    companyId: requested,
    wells,
    disposals: applyDispatchSwdDirectory(disposals.docs.map(d => project(d.data())), directory.docs.map(d => d.data())),
    customLocations: custom.filter(p=>p.ndicInactiveApproved!==true).map(c => {
      return { locationName: c.locationName, company: c.company, usageCount: typeof c.usageCount === 'number' ? c.usageCount : 0, latitude: c.latitude ?? null, longitude: c.longitude ?? null };
    }),
  };
});
