const mockRows = new Map<string, any>();
class MockRef {
  constructor(public path: string, public filter?: [string, any]) {}
  get id() { return this.path.split('/').at(-1)!; }
  collection(name: string) { return new MockRef(this.path + '/' + name); }
  doc(name: string) { return new MockRef(this.path + '/' + name); }
  limit() { return this; }
  where(field: string, _op: string, value: any) { return new MockRef(this.path, [field, value]); }
  async get() {
    const prefix = this.path + '/';
    return { docs: [...mockRows].filter(([key, value]) => key.startsWith(prefix)
      && !key.slice(prefix.length).includes('/') && (!this.filter || value[this.filter[0]] === this.filter[1]))
      .map(([key, value]) => mockSnapshot(key, value)) };
  }
}
function mockSnapshot(key: string, value: any) {
  return { id: key.split('/').at(-1), exists: !!value, data: () => value, get: (field: string) => value?.[field] };
}
jest.mock('firebase-admin', () => ({ firestore: Object.assign(() => ({ collection: (path: string) => new MockRef(path),
  runTransaction: async (work: any) => work({ get: async (ref: MockRef) => mockSnapshot(ref.path, mockRows.get(ref.path)),
    create: (ref: MockRef, value: any) => { if (mockRows.has(ref.path)) throw Error('exists'); mockRows.set(ref.path, value); },
    update: (ref: MockRef, value: any) => { const next={...mockRows.get(ref.path)};for(const [key,v] of Object.entries(value))next[key]=(v as any)?.arrayUnion ? [...(next[key]||[]),(v as any).arrayUnion]:v;mockRows.set(ref.path,next); },
    set: (ref: MockRef, value: any) => mockRows.set(ref.path, value) }),
}), { FieldValue: { arrayUnion: (value:any)=>({arrayUnion:value}), serverTimestamp: () => ({ toDate: () => new Date('2026-11-18T03:00:00Z') }) } }) }));
jest.mock('../requireDriverAuth', () => ({ requireSecureDriver: async (request: any, options: any) => {
  if (request.auth?.uid !== 'driver-a' || options.allowLegacyHash !== false) throw Error('unauthenticated');
  return { driverId: 'driver-id-a', companyId: 'company-a', displayName: 'Driver A' };
} }));
jest.mock('../trustedStaffAuthority', () => ({ requireTrustedCompanyCapability: async (uid: string, capability: string) => {
  if (uid === 'dispatcher-a' && capability === 'createDispatch') return { uid, companyId: 'company-a' };
  if (uid === 'dispatcher-b' && capability === 'createDispatch') return { uid, companyId: 'company-b' };
  if (uid === 'admin-a' && capability === 'manageCompany') return { uid, companyId: 'company-a' };
  throw Error('permission-denied');
} }));
import { driverArrivalLocationsHandler as driver, reviewArrivalLocationsHandler as staff } from '../arrivalLocations';
const req = (uid: string, data: any): any => ({ auth: { uid }, data });
const proposal = () => ({ action: 'propose', requestId: 'request-1', jobId: 'job-1', locationName: 'New Pad',
  locationType: 'place', latitude: 48, longitude: -103, accuracy: 10, observedAt: new Date().toISOString(), companyId: 'company-b' });
beforeEach(() => {mockRows.clear();mockRows.set('invoices/job-1',{companyId:'company-a',driverId:'driver-id-a'});});
test('driver proposal is tenant-bound, idempotent and never publishes a saved point', async () => {
  const body = proposal(); await driver(req('driver-a', body)); await driver(req('driver-a', body));
  expect([...mockRows.keys()].filter(key=>key.includes('arrival_location_requests'))).toHaveLength(1);
  expect([...mockRows.keys()].some(key=>key.startsWith('companies/company-a/arrival_location_requests/'))).toBe(true);
  expect([...mockRows].find(([key])=>key.includes('arrival_location_requests'))![1].status).toBe('pending');
  expect((await driver(req('driver-a', { action: 'list' })) as any).items).toHaveLength(0);
  await expect(driver(req('driver-a', { ...body, latitude: 49 }))).rejects.toThrow('reused');
});
test('only trusted dispatch/admin can review; foreign tenant and driver cannot approve', async () => {
  const result = await driver(req('driver-a', proposal()));
  await expect(staff(req('driver-a', { action: 'list' }))).rejects.toThrow('permission-denied');
  await expect(staff(req('dispatcher-b', { action: 'reject', id: result.id }))).rejects.toThrow('not found');
  expect((await staff(req('dispatcher-b', { action: 'list' })) as any).items).toHaveLength(0);
});
test('map verification and explicit approval are required; reviewed point/radius/type win without changing captured GPS', async () => {
  const result = await driver(req('driver-a', proposal()));
  const approve = { action: 'approve', id: result.id, latitude: 48.001, longitude: -103.001, radius: 350, locationType: 'swd' };
  await expect(staff(req('dispatcher-a', approve))).rejects.toThrow('Verify');
  await staff(req('admin-a', { ...approve, mapVerified: true }));
  const approved = (await driver(req('driver-a', { action: 'list' })) as any).items[0] as any;
  expect(approved).toMatchObject({ latitude: 48.001, longitude: -103.001, radius: 350, locationType: 'swd', approvedBy: 'admin-a' });
  const original = [...mockRows.entries()].find(([key]) => key.includes('arrival_location_requests'))![1];
  expect(original.latitude).toBe(48); expect(original.status).toBe('approved');
  await expect(staff(req('dispatcher-a', { ...approve, mapVerified: true }))).rejects.toThrow('already been reviewed');
});
test('rejection leaves saved locations unchanged; invalid GPS and unauthenticated requests refuse', async () => {
  const result = await driver(req('driver-a', proposal()));
  await staff(req('dispatcher-a', { action: 'reject', id: result.id }));
  expect((await driver(req('driver-a', { action: 'list' })) as any).items).toHaveLength(0);
  await expect(driver(req('other', proposal()))).rejects.toThrow('unauthenticated');
  await expect(driver(req('driver-a', { ...proposal(), latitude: 91 }))).rejects.toThrow('Invalid GPS');
  await expect(driver(req('driver-a', { ...proposal(), accuracy: 100 }))).rejects.toThrow('precise');
});

test('drop-off history appends once without replacing prior events, captured GPS or destination fields', async () => {
  mockRows.set('invoices/job-1', { companyId:'company-a', driverId:'driver-id-a', canonicalJobId:'canonical-1', hauledTo:'Hydro Clear', arrivedEvent:{lat:48,lng:-103} });
  mockRows.set('canonical_jobs/canonical-1', { companyId:'company-a', invoiceDocId:'job-1', events:[{type:'packet_sent'}] });
  const body={action:'logChange',requestId:'change-1',jobId:'job-1',from:'Hydro Clear',to:'WO Watford',reason:'Closed gate',observedAt:new Date().toISOString()};
  await driver(req('driver-a',body));await driver(req('driver-a',body));
  expect(mockRows.get('canonical_jobs/canonical-1').events).toHaveLength(2);
  expect(mockRows.get('canonical_jobs/canonical-1').events[0]).toEqual({type:'packet_sent'});
  expect(mockRows.get('canonical_jobs/canonical-1').events[1].notes).toContain('Closed gate');
  expect(mockRows.get('invoices/job-1')).toMatchObject({hauledTo:'Hydro Clear',arrivedEvent:{lat:48,lng:-103}});
  await expect(driver(req('driver-a',{...body,reason:'different'}))).rejects.toThrow('reused');
  mockRows.set('invoices/foreign', {companyId:'company-b',driverId:'driver-id-a'});
  await expect(driver(req('driver-a',{...body,jobId:'foreign'}))).rejects.toThrow('not yours');
});
