const records = new Map<string, any>();
let companyId = 'company-a';
jest.mock('../../trustedStaffAuthority', () => ({
  requireTrustedCompanyCapability: jest.fn(async (uid: string, capability: string) => {
    if (uid !== 'staff' || !['viewDispatch', 'manageCompany'].includes(capability)) throw Error('permission-denied');
    return { uid, companyId };
  }),
}));
const snapshot = (path: string) => ({ exists: records.has(path), id: path.split('/').pop(), data: () => records.get(path) });
const ref = (path: string): any => ({
  path, get: async () => snapshot(path),
  set: async (data: any, options?: { merge?: boolean }) => records.set(path, options?.merge ? { ...records.get(path), ...data } : data),
  collection: (name: string) => collection(`${path}/${name}`),
});
const collection = (path: string): any => ({
  doc: (id: string) => ref(`${path}/${id}`),
  limit: (_n: number) => ({ get: async () => ({ docs: [...records.keys()].filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
    .map(key => snapshot(key)) }) }),
});
const db = { collection };
jest.mock('firebase-admin', () => ({ firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 'SERVER_TIME' } }) }));
jest.mock('firebase-functions/v2/https', () => ({ onCall: (_: any, handler: any) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
import { staffIndependentDispatchDirectory } from '../../independentDispatchDirectoryCallable';
import { requireTrustedCompanyCapability } from '../../trustedStaffAuthority';
const call = (data: any, uid = 'staff') => (staffIndependentDispatchDirectory as any)({ auth: { uid }, data });
beforeEach(() => {
  records.clear(); companyId = 'company-a'; jest.clearAllMocks();
  records.set('companies/company-a', { activePackages: ['independent-dispatch'] });
});
describe('Independent Dispatch directory', () => {
  it('defaults to five sectors and stores a company-scoped customer directory', async () => {
    await expect(call({ op: 'list' })).resolves.toMatchObject({ companyId: 'company-a', sectors: ['water-hauling', 'ltl', 'otr', 'hot-shot', 'aggregate'], communicationChannels: [], dispatchPhoneE164: '', customers: [] });
    await call({ op: 'setCommunications', communicationChannels: ['sms', 'whatsapp'], dispatchPhoneE164: '+17015550100' });
    await call({ op: 'setCatalogOperators', catalogOperators: ['XTO ENERGY INC', 'EXXONMOBIL OIL CORPORATION'] });
    await call({ op: 'setSectors', sectors: ['ltl', 'otr'] });
    await expect(call({ op: 'list' })).resolves.toMatchObject({ communicationChannels: ['sms', 'whatsapp'], dispatchPhoneE164: '+17015550100' });
    await expect(call({ op: 'list' })).resolves.toMatchObject({ catalogOperators: ['XTO ENERGY INC', 'EXXONMOBIL OIL CORPORATION'] });
    await expect(call({ op: 'saveCustomer', customer: { id: 'customer-a', name: 'Customer A', active: true,
      sectors: ['aggregate'], jobNames: [], pickupLocations: [], deliveryLocations: [] } })).rejects.toThrow('customer_sector_disabled');
    await call({ op: 'saveCustomer', customer: { id: 'customer-a', name: '  Customer A  ', active: true,
      sectors: ['ltl'], alternateNames: ['CA', 'Cust A'], contacts: [
        { id: 'contact-john', name: 'John Wick', role: 'Company man', phoneE164: '+17015550112' },
        { id: 'contact-jane', name: 'Jane Doe', role: 'Lead', phoneE164: '+17015550113' },
      ], phoneE164: '+17015550111', jobNames: ['Pallet delivery'], pickupLocations: ['Yard A'], deliveryLocations: ['Site B'] } });
    await expect(call({ op: 'list' })).resolves.toMatchObject({ sectors: ['ltl', 'otr'], customers: [{ id: 'customer-a', name: 'Customer A', alternateNames: ['CA', 'Cust A'],
      contacts: [{ name: 'John Wick', phoneE164: '+17015550112' }, { name: 'Jane Doe', phoneE164: '+17015550113' }],
      phoneE164: '+17015550111', pickupLocations: ['Yard A'] }] });
    await expect(call({ op: 'saveCustomer', customer: { id: 'customer-b', name: 'Customer B', active: true,
      sectors: ['ltl'], alternateNames: ['CA'], jobNames: [], pickupLocations: [], deliveryLocations: [] } })).rejects.toThrow('customer_name_conflict');
    await expect(call({ op: 'saveCustomer', customer: { id: 'customer-b', name: 'CA', active: true,
      sectors: ['ltl'], alternateNames: [], jobNames: [], pickupLocations: [], deliveryLocations: [] } })).rejects.toThrow('customer_name_conflict');
    expect(requireTrustedCompanyCapability).toHaveBeenCalledWith('staff', 'manageCompany');
    expect(records.get('companies/company-a/independent_dispatch_customers/customer-a').companyId).toBe('company-a');
  });
  it('returns only the current company approved route guides', async () => {
    records.set('companies/company-a/independent_dispatch_config/settings', { sectors: ['water-hauling'], routeGuides: [{
      id: 'access', title: 'Approved route', locations: ['Barnstormer'],
      imageUrls: ['https://firebasestorage.googleapis.com/v0/b/wellbuilt-sync.firebasestorage.app/o/map?alt=media&token=x'],
      routeWaypoints: [{ lat: 47.6912663, lng: -103.4562861 }, { lat: 47.689123, lng: -103.453253 }, { lat: 47.689152, lng: -103.440293 }],
      padPins: [{ label: 'Barnstormer 1/2', location: 'Barnstormer', url: 'https://maps.app.goo.gl/nByM7Fpw6F6npf1s5',
        lat: 47.673974, lng: -103.410378, matchTerms: ['Barnstormer 1', 'Barnstormer 2'] }],
    }] });
    records.set('companies/company-b/independent_dispatch_config/settings', { routeGuides: [{
      id: 'other', title: 'Other company', locations: ['Secret'], imageUrls: [],
    }] });
    await expect(call({ op: 'list' })).resolves.toMatchObject({ routeGuides: [{ id: 'access', padPins: [{ label: 'Barnstormer 1/2' }] }] });
  });
  it('rejects users without the package and invalid customer payloads', async () => {
    records.set('companies/company-a', { activePackages: ['water-hauling'] });
    await expect(call({ op: 'list' })).rejects.toThrow('package_inactive');
    records.set('companies/company-a', { activePackages: ['independent-dispatch'] });
    await expect(call({ op: 'saveCustomer', customer: { id: 'customer-a', name: 'A', active: true,
      sectors: ['ltl'], jobNames: [], pickupLocations: ['Yard', 'yard'], deliveryLocations: [] } })).rejects.toThrow('invalid_pickup_locations');
    await expect(call({ op: 'setSectors', sectors: ['ltl', 'ltl'] })).rejects.toThrow('invalid_sectors');
    await expect(call({ op: 'setCommunications', communicationChannels: ['sms', 'sms'], dispatchPhoneE164: '' })).rejects.toThrow('invalid_communications');
    await expect(call({ op: 'setCommunications', communicationChannels: ['email'], dispatchPhoneE164: '' })).rejects.toThrow('invalid_communications');
    await expect(call({ op: 'setCommunications', communicationChannels: [], dispatchPhoneE164: '555-0100' })).rejects.toThrow('invalid_communications');
    await expect(call({ op: 'setCatalogOperators', catalogOperators: ['XTO', 'xto'] })).rejects.toThrow('invalid_catalog_operators');
    await expect(call({ op: 'saveCustomer', customer: { id: 'customer-a', name: 'A', active: true,
      sectors: ['ltl'], phoneE164: '555-1111', jobNames: [], pickupLocations: [], deliveryLocations: [] } })).rejects.toThrow('invalid_customer_phone');
    await expect(call({ op: 'saveCustomer', customer: { id: 'customer-a', name: 'A', active: true,
      sectors: ['ltl'], alternateNames: ['BHS', 'bhs'], jobNames: [], pickupLocations: [], deliveryLocations: [] } })).rejects.toThrow('invalid_alternate_names');
    await expect(call({ op: 'saveCustomer', customer: { id: 'customer-a', name: 'A', active: true,
      sectors: ['ltl'], contacts: [{ id: 'john', name: 'John', role: 'Company man', phoneE164: '701-555-0123' }],
      jobNames: [], pickupLocations: [], deliveryLocations: [] } })).rejects.toThrow('invalid_customer_contact');
    await expect(call({ op: 'list', companyId: 'company-b' })).rejects.toThrow('invalid_directory_request');
  });
  it('keeps categories and channel labels inside the selected customer profile', async () => {
    const base = { id: 'exxon', name: 'ExxonMobil', active: true, sectors: ['water-hauling'],
      jobNames: [], pickupLocations: [], deliveryLocations: [] };
    await call({ op: 'saveCustomer', customer: { ...base, workCategories: [{ id: 'rig-work', name: 'Rig Work',
      sector: 'water-hauling', sourceChannels: ['ExxonMobil - RIG WORK'], assets: ['H&P Rig 429', 'H&P Rig 640'] }] } });
    await expect(call({ op: 'list' })).resolves.toMatchObject({ customers: [{ name: 'ExxonMobil', workCategories: [{
      name: 'Rig Work', sourceChannels: ['ExxonMobil - RIG WORK'], assets: ['H&P Rig 429', 'H&P Rig 640'],
    }] }] });
    await expect(call({ op: 'saveCustomer', customer: { ...base, workCategories: [
      { id: 'one', name: 'Rig Work', sector: 'water-hauling', sourceChannels: [], assets: [] },
      { id: 'two', name: 'rig-work', sector: 'water-hauling', sourceChannels: [], assets: [] },
    ] } })).rejects.toThrow('duplicate_work_category');
    await expect(call({ op: 'saveCustomer', customer: { ...base, workCategories: [{ id: 'rig-work', name: 'Rig Work',
      sector: 'ltl', sourceChannels: [], assets: [] }] } })).rejects.toThrow('invalid_work_category');
  });
});
