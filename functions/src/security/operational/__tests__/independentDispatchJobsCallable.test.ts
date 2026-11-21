const records = new Map<string, any>();
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
    get: async () => ({ docs: [...records].filter(([key, value]) => key.startsWith(path + '/') && key.split('/').length === 2 && value.companyId === companyId)
      .map(([key, value]) => ({ id: key.split('/').pop(), data: () => value })) }),
  }) };
}
const db = { collection: collectionRef, runTransaction: async (fn: any) => {
  const writes: (() => void)[] = [];
  const result = await fn({ get: (ref: any) => ref.get(), set: (ref: any, value: any) => writes.push(() => records.set(ref.path, value)),
    create: (ref: any, value: any) => writes.push(() => records.set(ref.path, value)) });
  writes.forEach(write => write()); return result;
} };
jest.mock('firebase-admin', () => ({ firestore: () => db }));
jest.mock('firebase-functions/v2/https', () => ({ onCall: (_: any, handler: any) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
import { staffIndependentDispatchJobs } from '../../independentDispatchJobsCallable';
import { requireTrustedCompanyCapability } from '../../trustedStaffAuthority';
const call = (data: any) => (staffIndependentDispatchJobs as any)({ auth: { uid: authority.uid }, data });
const details = { title: 'Delivery', customer: 'Customer', pickup: 'Yard', destination: 'Site' };
const create = { op: 'create', jobId: 'job-a', requestId: 'request-a', job: details };
beforeEach(() => {
  records.clear(); jest.clearAllMocks();
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
  it('records staff progress and audit without creating water dispatches or tickets', async () => {
    await call(create);
    await expect(call({ op: 'status', jobId: 'job-a', requestId: 'finish', expectedRevision: 1, status: 'completed' })).rejects.toThrow('invalid_job_transition');
    await call({ op: 'status', jobId: 'job-a', requestId: 'cancel', expectedRevision: 1, status: 'cancelled' });
    expect(records.get('independent_dispatch_jobs/job-a/events/cancel')).toMatchObject({ actorUid: 'dispatcher', fromStatus: 'unassigned', toStatus: 'cancelled' });
    expect([...records.keys()].some(key => key.startsWith('dispatches/') || key.startsWith('tickets/'))).toBe(false);
  });
});
