const records = new Map<string, any>();
const profiles = new Map<string, any>();
const authority = { uid: 'dispatcher', companyId: 'company-a' };
jest.mock('../../trustedStaffAuthority', () => ({
  requireTrustedCompanyCapability: jest.fn(async () => authority),
}));
function docRef(path: string): any {
  return { id: path.split('/').pop(), path,
    get: async () => ({ exists: records.has(path), id: path.split('/').pop(), data: () => records.get(path) }),
    collection: (name: string) => collectionRef(`${path}/${name}`) };
}
function collectionRef(path: string): any {
  return { doc: (id: string) => docRef(`${path}/${id}`), where: (_: string, __: string, companyId: string) => ({
    get: async () => ({ docs: [...records].filter(([key, value]) => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1 && value.companyId === companyId)
      .map(([key, value]) => ({ id: key.split('/').pop(), data: () => value })) }),
  }) };
}
const db = { collection: collectionRef, runTransaction: async (fn: any) => {
  const writes: (() => void)[] = [];
  const result = await fn({ get: (ref: any) => ref.get(), set: (ref: any, value: any) => writes.push(() => records.set(ref.path, value)),
    create: (ref: any, value: any) => writes.push(() => records.set(ref.path, value)) });
  writes.forEach(write => write()); return result;
} };
jest.mock('firebase-admin', () => ({ firestore: () => db,
  database: () => ({ ref: (path: string) => ({ get: async () => ({ val: () => profiles.get(path) || null }) }) }),
  auth: () => ({ getUser: async () => ({ disabled: false }) }),
}));
jest.mock('../../tokenMint', () => ({ driverAuthUid: (id: string) => `driver_${id}` }));
jest.mock('firebase-functions/v2/https', () => ({ onCall: (_: any, handler: any) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
import { staffIndependentDispatchJobs } from '../../independentDispatchJobsCallable';
import { requireTrustedCompanyCapability } from '../../trustedStaffAuthority';
const call = (data: any) => (staffIndependentDispatchJobs as any)({ auth: { uid: authority.uid }, data });
const details = { title: 'Delivery', customer: 'Customer', pickup: 'Yard', destination: 'Site' };
const create = { op: 'create', jobId: 'job-a', requestId: 'request-a', job: details };
beforeEach(() => {
  records.clear(); profiles.clear(); jest.clearAllMocks();
  records.set('companies/company-a', { activePackages: ['independent-dispatch'] });
});
describe('Independent Dispatch callable boundaries', () => {
  it('fails closed for inactive packages', async () => {
    records.set('companies/company-a', { activePackages: ['water-hauling'] });
    await expect(call({ op: 'list' })).rejects.toThrow('package_inactive');
    expect(records.size).toBe(1);
  });
  it('creates once, returns identical retry, and rejects changed retry payload', async () => {
    await call(create); await expect(call(create)).resolves.toMatchObject({ idempotent: true });
    await expect(call({ ...create, job: { ...details, title: 'Different' } })).rejects.toThrow('request_conflict');
    expect(records.get('independent_dispatch_jobs/job-a').revision).toBe(1);
  });
  it('rejects cross-company lookup, modification, and list leakage', async () => {
    records.set('independent_dispatch_jobs/foreign', { companyId: 'company-b', revision: 1, updatedAt: '2026' });
    await expect(call({ op: 'update', jobId: 'foreign', requestId: 'req', expectedRevision: 1, job: details })).rejects.toThrow('cross_company');
    await expect(call({ op: 'list' })).resolves.toMatchObject({ companyId: 'company-a', jobs: [] });
  });
  it('rejects stale edits and requires an active same-company driver and manageDrivers', async () => {
    await call(create);
    await expect(call({ op: 'update', jobId: 'job-a', requestId: 'req', expectedRevision: 2, job: details })).rejects.toThrow('job_changed');
    const assign = { op: 'assign', jobId: 'job-a', requestId: 'assign-a', expectedRevision: 1, externalDriverId: 'driver-a' };
    records.set('companies/company-a/external_drivers/driver-a', { companyId: 'company-b', active: true });
    await expect(call(assign)).rejects.toThrow('external_driver_inactive');
    records.set('companies/company-a/external_drivers/driver-a', { companyId: 'company-a', active: true, displayName: 'Driver' });
    await expect(call(assign)).resolves.toMatchObject({ job: { status: 'assigned', revision: 2 } });
    expect(requireTrustedCompanyCapability).toHaveBeenCalledWith('dispatcher', 'manageDrivers');
  });
  it('lists only approved WellBuilt links and assigns a live linked profile without phone-app delivery', async () => {
    const id = 'wb-marcial';
    const link = { companyId: 'company-a', sourceCompanyId: 'liquid-gold', driverId: id,
      authUid: `driver_${id}`, displayName: 'Nitto–Anthony (Marcial Lebaron)', active: true };
    records.set(`companies/company-a/independent_dispatch_wb_drivers/${id}`, link);
    records.set('companies/company-a/independent_dispatch_wb_drivers/foreign', { ...link, driverId: 'foreign', companyId: 'company-b' });
    records.set('companies/company-a/independent_dispatch_wb_drivers/disabled', { ...link, driverId: 'disabled', active: false });
    profiles.set(`drivers/profiles/${id}`, { companyId: 'liquid-gold', active: true });
    await expect(call({ op: 'list' })).resolves.toMatchObject({ wbDrivers: [{ driverId: id, displayName: link.displayName }] });
    await call(create);
    const assigned = await call({ op: 'assign', jobId: 'job-a', requestId: 'wb-assign', expectedRevision: 1, wbDriverId: id });
    expect(assigned.job).toMatchObject({ wbDriverId: id, wbDriverCompanyId: 'liquid-gold',
      driverName: link.displayName, driverSource: 'wellbuilt', externalDriverId: '', status: 'assigned' });
    expect([...records.keys()].some(key => key.startsWith('dispatches/') || key.startsWith('tickets/'))).toBe(false);
  });
  it('rejects an unlinked or cross-company WellBuilt profile', async () => {
    await call(create);
    profiles.set('drivers/profiles/wb-marcial', { companyId: 'liquid-gold', active: true });
    const assign = { op: 'assign', jobId: 'job-a', requestId: 'wb-assign', expectedRevision: 1, wbDriverId: 'wb-marcial' };
    await expect(call(assign)).rejects.toThrow('wellbuilt_driver_not_linked');
    records.set('companies/company-a/independent_dispatch_wb_drivers/wb-marcial', { companyId: 'company-a',
      sourceCompanyId: 'another-company', driverId: 'wb-marcial', authUid: 'driver_wb-marcial', displayName: 'Marcial', active: true });
    await expect(call(assign)).rejects.toThrow('wellbuilt_driver_not_linked');
    profiles.set('drivers/profiles/wb-marcial', { companyId: 'another-company', active: false });
    await expect(call(assign)).rejects.toThrow('wellbuilt_driver_inactive');
  });
  it('records staff progress and audit without creating water dispatches or tickets', async () => {
    await call(create);
    await expect(call({ op: 'status', jobId: 'job-a', requestId: 'finish', expectedRevision: 1, status: 'completed' })).rejects.toThrow('invalid_job_transition');
    await call({ op: 'status', jobId: 'job-a', requestId: 'cancel', expectedRevision: 1, status: 'cancelled' });
    expect(records.get('independent_dispatch_jobs/job-a/events/cancel')).toMatchObject({ actorUid: 'dispatcher', fromStatus: 'unassigned', toStatus: 'cancelled' });
    expect([...records.keys()].some(key => key.startsWith('dispatches/') || key.startsWith('tickets/'))).toBe(false);
  });
  it('binds a sector job to an enabled company sector and same-company customer', async () => {
    records.set('companies/company-a/independent_dispatch_config/settings', { sectors: ['ltl'] });
    records.set('companies/company-a/independent_dispatch_customers/customer-a', { companyId: 'company-a', name: 'Customer A', active: true, sectors: ['ltl'] });
    const sectorJob = { ...details, customerId: 'customer-a', sector: 'ltl', sectorFields: { freightDescription: 'Pallets', pieces: '4' } };
    await call({ ...create, job: sectorJob });
    expect(records.get('independent_dispatch_jobs/job-a')).toMatchObject({ sector: 'ltl', customerId: 'customer-a', customer: 'Customer A' });
    await expect(call({ ...create, jobId: 'job-b', requestId: 'request-b', job: { ...sectorJob, sector: 'otr', sectorFields: { trailerType: 'Dry van', commodity: 'Parts' } } })).rejects.toThrow('sector_disabled');
    records.set('companies/company-a/independent_dispatch_customers/customer-a', { companyId: 'company-b', name: 'Foreign', active: true, sectors: ['ltl'] });
    await expect(call({ ...create, jobId: 'job-c', requestId: 'request-c', job: sectorJob })).rejects.toThrow('customer_sector_unavailable');
  });
  it('keeps a one-off customer on the job, or saves a reusable official name only when requested', async () => {
    records.set('companies/company-a/independent_dispatch_config/settings', { sectors: ['ltl'] });
    const oneOff = { ...details, customer: 'One Time Freight LLC', sector: 'ltl', sectorFields: { freightDescription: 'Pallets', pieces: '4' } };
    await call({ ...create, job: oneOff });
    expect(records.get('independent_dispatch_jobs/job-a')).toMatchObject({ customer: 'One Time Freight LLC', sector: 'ltl' });
    expect(records.get('independent_dispatch_jobs/job-a').customerId).toBeUndefined();
    expect([...records.keys()].filter(key => key.includes('independent_dispatch_customers'))).toEqual([]);
    const saved = { ...create, jobId: 'job-b', requestId: 'request-b', job: { ...oneOff, customer: "Bob's Hot Shot LLC" }, saveCustomer: true };
    await call(saved);
    expect(records.get('independent_dispatch_jobs/job-b').customerId).toBe('job_job-b');
    expect(records.get('companies/company-a/independent_dispatch_customers/job_job-b')).toMatchObject({
      companyId: 'company-a', name: "Bob's Hot Shot LLC", alternateNames: [], sectors: ['ltl'], active: true,
    });
    await expect(call(saved)).resolves.toMatchObject({ idempotent: true });
    expect([...records.keys()].filter(key => key.includes('independent_dispatch_customers'))).toHaveLength(1);
  });
});
