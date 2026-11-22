import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { requireIndependentDispatchAuthority } from './independentDispatchAuthority';
import { hasIndependentDispatchPackage } from './operational/independentDispatchPackage';
import { INDEPENDENT_SECTORS, parseIndependentSectors } from './operational/independentDispatchSectors';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DEFAULT_SECTORS = [...INDEPENDENT_SECTORS];
const normalizeCustomerName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function names(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string'
    || !item.trim() || item.length > 180) || new Set(value.map((item: string) => item.trim().toLowerCase())).size !== value.length)
    throw new httpsV2.HttpsError('invalid-argument', `invalid_${field}`);
  return value.map((item: string) => item.trim());
}
function customerContacts(value: unknown): { id: string; name: string; role: string; phoneE164: string }[] {
  if (!Array.isArray(value) || value.length > 30) throw new httpsV2.HttpsError('invalid-argument', 'invalid_customer_contacts');
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_customer_contact');
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !['id', 'name', 'role', 'phoneE164'].includes(key))
      || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120
      || typeof row.role !== 'string' || row.role.length > 80
      || typeof row.phoneE164 !== 'string'
      || (row.phoneE164 !== '' && !/^\+[1-9]\d{7,14}$/.test(row.phoneE164)))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_customer_contact');
    ids.add(row.id);
    return { id: row.id, name: row.name.trim(), role: row.role.trim(), phoneE164: row.phoneE164 };
  });
}

/** Company-owned sector choices, customer lists, and reusable locations. */
export const staffIndependentDispatchDirectory = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const data = request.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !['op', 'sectors', 'customer', 'communicationChannels', 'dispatchPhoneE164'].includes(key))
      || !['list', 'setSectors', 'setCommunications', 'saveCustomer'].includes(data.op))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_directory_request');
    const authority = data.op === 'list'
      ? await requireIndependentDispatchAuthority(request.auth?.uid, 'viewDispatch')
      : await requireTrustedCompanyCapability(request.auth?.uid, 'manageCompany');
    const db = admin.firestore();
    const companyRef = db.collection('companies').doc(authority.companyId);
    const configRef = companyRef.collection('independent_dispatch_config').doc('settings');
    const customersRef = companyRef.collection('independent_dispatch_customers');
    const company = await companyRef.get();
    if (!hasIndependentDispatchPackage(company.data()))
      throw new httpsV2.HttpsError('permission-denied', 'independent_dispatch_package_inactive');
    if (data.op === 'list') {
      if (Object.keys(data).length !== 1) throw new httpsV2.HttpsError('invalid-argument', 'unexpected_directory_fields');
      const [config, customers] = await Promise.all([configRef.get(), customersRef.limit(500).get()]);
      const sectors = config.exists ? parseIndependentSectors(config.data()?.sectors) : DEFAULT_SECTORS;
      const communicationChannels = (Array.isArray(config.data()?.communicationChannels)
        ? config.data()!.communicationChannels : []).filter((value: unknown) => value === 'sms' || value === 'whatsapp');
      const dispatchPhoneE164 = typeof config.data()?.dispatchPhoneE164 === 'string' ? config.data()!.dispatchPhoneE164 : '';
      return { ok: true, companyId: authority.companyId, sectors, communicationChannels, dispatchPhoneE164,
        customers: customers.docs.map(doc => ({ ...doc.data(), id: doc.id })).filter((row: any) => row.active !== false)
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))) };
    }
    if (data.op === 'setSectors') {
      if (Object.keys(data).length !== 2) throw new httpsV2.HttpsError('invalid-argument', 'unexpected_directory_fields');
      let sectors;
      try { sectors = parseIndependentSectors(data.sectors); }
      catch { throw new httpsV2.HttpsError('invalid-argument', 'invalid_sectors'); }
      await configRef.set({ sectors, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: authority.uid }, { merge: true });
      return { ok: true, sectors };
    }
    if (data.op === 'setCommunications') {
      if (Object.keys(data).length !== 3 || !Array.isArray(data.communicationChannels)
        || data.communicationChannels.length > 2
        || new Set(data.communicationChannels).size !== data.communicationChannels.length
        || data.communicationChannels.some((value: unknown) => value !== 'sms' && value !== 'whatsapp')
        || typeof data.dispatchPhoneE164 !== 'string'
        || (data.dispatchPhoneE164 !== '' && !/^\+[1-9]\d{7,14}$/.test(data.dispatchPhoneE164)))
        throw new httpsV2.HttpsError('invalid-argument', 'invalid_communications');
      const communicationChannels = data.communicationChannels as ('sms' | 'whatsapp')[];
      const dispatchPhoneE164 = data.dispatchPhoneE164 as string;
      await configRef.set({ communicationChannels, dispatchPhoneE164, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: authority.uid }, { merge: true });
      return { ok: true, communicationChannels, dispatchPhoneE164 };
    }
    if (Object.keys(data).length !== 2 || !data.customer || typeof data.customer !== 'object' || Array.isArray(data.customer))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_customer');
    const raw = data.customer as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['id', 'name', 'alternateNames', 'contacts', 'phoneE164', 'sectors', 'jobNames', 'pickupLocations', 'deliveryLocations', 'active'].includes(key))
      || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.name !== 'string'
      || !raw.name.trim() || raw.name.length > 180 || raw.active !== true)
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_customer');
    const phoneE164 = raw.phoneE164 === undefined ? '' : raw.phoneE164;
    if (typeof phoneE164 !== 'string' || (phoneE164 !== '' && !/^\+[1-9]\d{7,14}$/.test(phoneE164)))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_customer_phone');
    let sectors;
    try { sectors = parseIndependentSectors(raw.sectors); }
    catch { throw new httpsV2.HttpsError('invalid-argument', 'invalid_customer_sectors'); }
    const config = await configRef.get();
    const enabled = config.exists ? parseIndependentSectors(config.data()?.sectors) : DEFAULT_SECTORS;
    if (sectors.some(sector => !enabled.includes(sector)))
      throw new httpsV2.HttpsError('failed-precondition', 'customer_sector_disabled');
    const alternateNames = names(raw.alternateNames ?? [], 'alternate_names', 30);
    const identifiers = [raw.name.trim(), ...alternateNames].map(normalizeCustomerName);
    if (new Set(identifiers).size !== identifiers.length)
      throw new httpsV2.HttpsError('invalid-argument', 'duplicate_customer_name_or_alias');
    const existing = await customersRef.limit(500).get();
    if (existing.docs.some(doc => doc.id !== raw.id && doc.data().companyId === authority.companyId
      && doc.data().active !== false
      && [doc.data().name, ...(Array.isArray(doc.data().alternateNames) ? doc.data().alternateNames : [])]
        .some((name: unknown) => typeof name === 'string' && identifiers.includes(normalizeCustomerName(name)))))
      throw new httpsV2.HttpsError('failed-precondition', 'customer_name_conflict');
    const customer = { companyId: authority.companyId, name: raw.name.trim(), phoneE164, sectors,
      alternateNames,
      contacts: customerContacts(raw.contacts ?? []),
      jobNames: names(raw.jobNames, 'job_names', 30),
      pickupLocations: names(raw.pickupLocations, 'pickup_locations', 50),
      deliveryLocations: names(raw.deliveryLocations, 'delivery_locations', 50),
      active: true, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: authority.uid };
    await customersRef.doc(raw.id).set(customer, { merge: true });
    return { ok: true, customer: { id: raw.id, ...customer } };
  },
);
