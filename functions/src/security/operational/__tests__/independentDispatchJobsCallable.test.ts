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
  }), limit: (_n: number) => ({ get: async () => ({ docs: [...records].filter(([key]) => key.startsWith(path + '/')
    && key.split('/').length === path.split('/').length + 1)
    .map(([key, value]) => ({ id: key.split('/').pop(), data: () => value })) }) }) };
}
const db = { collection: collectionRef, runTransaction: async (fn: any) => {
  const writes: (() => void)[] = [];
  const result = await fn({ get: (ref: any) => ref.get(), set: (ref: any, value: any) => writes.push(() => records.set(ref.path, value)),
    update: (ref: any, value: any) => writes.push(() => records.set(ref.path, { ...records.get(ref.path), ...value })),
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
import { staffIndependentDriverProfiles } from '../../independentDriverProfilesCallable';
import { requireTrustedCompanyCapability } from '../../trustedStaffAuthority';
const call = (data: any) => (staffIndependentDispatchJobs as any)({ auth: { uid: authority.uid }, data });
const profileCall = (data: any) => (staffIndependentDriverProfiles as any)({ auth: { uid: authority.uid }, data });
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
  it('blocks overlapping assignments, including ongoing shift work, until the open job is completed', async () => {
    const shiftJob = { ...details, scheduledAt: '2026-11-23T08:00:00.000Z', estimatedEndAt: '2026-11-23T20:00:00.000Z', shift: 'day', ongoing: true };
    const nextJob = { ...details, scheduledAt: '2026-11-24T08:00:00.000Z', estimatedEndAt: '2026-11-24T20:00:00.000Z', shift: 'night' };
    records.set('companies/company-a/external_drivers/driver-a', { companyId: 'company-a', active: true, displayName: 'Driver' });
    await call({ ...create, job: shiftJob });
    await call({ ...create, jobId: 'job-b', requestId: 'create-b', job: nextJob });
    await call({ op: 'assign', jobId: 'job-a', requestId: 'assign-a', expectedRevision: 1, externalDriverId: 'driver-a' });
    const secondAssign = { op: 'assign', jobId: 'job-b', requestId: 'assign-b', expectedRevision: 1, externalDriverId: 'driver-a' };
    await expect(call(secondAssign)).rejects.toThrow('driver_assignment_conflict');
    await call({ op: 'status', jobId: 'job-a', requestId: 'started-a', expectedRevision: 2, status: 'in_progress' });
    await expect(call(secondAssign)).rejects.toThrow('driver_assignment_conflict');
    await call({ op: 'status', jobId: 'job-a', requestId: 'completed-a', expectedRevision: 3, status: 'completed' });
    await expect(call(secondAssign)).resolves.toMatchObject({ job: { status: 'assigned', driverName: 'Driver' } });
  });
  it('keeps a day and night crew on one job and audits a driver swap without losing the other shift', async () => {
    for (const id of ['day-a', 'night-a', 'day-b']) records.set(`companies/company-a/external_drivers/${id}`,
      { companyId: 'company-a', externalDriverId: id, active: true, displayName: id });
    await call(create);
    const day = await call({ op: 'addDriver', jobId: 'job-a', requestId: 'day-a', expectedRevision: 1, externalDriverId: 'day-a', shift: 'day' });
    expect(day.job).toMatchObject({ status: 'assigned', drivers: [{ key: 'outside:day-a', shift: 'day' }] });
    const night = await call({ op: 'addDriver', jobId: 'job-a', requestId: 'night-a', expectedRevision: 2, externalDriverId: 'night-a', shift: 'night' });
    expect(night.job.drivers.map((driver: any) => [driver.key, driver.shift])).toEqual([['outside:day-a', 'day'], ['outside:night-a', 'night']]);
    await expect(call({ op: 'assign', jobId: 'job-a', requestId: 'stale-reassign', expectedRevision: 3, externalDriverId: 'day-b' }))
      .rejects.toThrow('use_crew_assignment');
    await expect(call({ op: 'addDriver', jobId: 'job-a', requestId: 'duplicate', expectedRevision: 3, externalDriverId: 'night-a', shift: 'night' }))
      .rejects.toThrow('driver_already_on_job');
    const swapped = await call({ op: 'replaceDriver', jobId: 'job-a', requestId: 'swap-day', expectedRevision: 3,
      driverKey: 'outside:day-a', externalDriverId: 'day-b', shift: 'day' });
    expect(swapped.job.drivers.map((driver: any) => [driver.key, driver.shift])).toEqual([['outside:day-b', 'day'], ['outside:night-a', 'night']]);
    expect(records.get('independent_dispatch_jobs/job-a/events/swap-day')).toMatchObject({
      beforeDrivers: [{ key: 'outside:day-a', shift: 'day' }, { key: 'outside:night-a', shift: 'night' }],
      afterDrivers: [{ key: 'outside:day-b', shift: 'day' }, { key: 'outside:night-a', shift: 'night' }],
    });
    const removed = await call({ op: 'removeDriver', jobId: 'job-a', requestId: 'remove-night', expectedRevision: 4, driverKey: 'outside:night-a' });
    expect(removed.job.drivers).toHaveLength(1);
    expect(removed.job.status).toBe('assigned');
    await call({ op: 'status', jobId: 'job-a', requestId: 'started', expectedRevision: 5, status: 'in_progress' });
    await expect(call({ op: 'removeDriver', jobId: 'job-a', requestId: 'remove-last', expectedRevision: 6, driverKey: 'outside:day-b' }))
      .rejects.toThrow('replace_last_active_driver');
  });
  it('adds a checked crew atomically with one revision and rejects a partly unavailable selection', async () => {
    for (const id of ['outside-a', 'outside-b', 'outside-c']) records.set(`companies/company-a/external_drivers/${id}`,
      { companyId: 'company-a', externalDriverId: id, active: true, displayName: id });
    const id = 'wb-marcial';
    records.set(`companies/company-a/independent_dispatch_wb_drivers/${id}`, {
      companyId: 'company-a', sourceCompanyId: 'liquid-gold', driverId: id, authUid: `driver_${id}`,
      displayName: 'Marcial', active: true,
    });
    profiles.set(`drivers/profiles/${id}`, { companyId: 'liquid-gold', active: true });
    await call({ ...create, job: { ...details, ongoing: true } });
    const batch = { op: 'addDrivers', jobId: 'job-a', requestId: 'crew-a', expectedRevision: 1,
      drivers: [{ key: 'outside:outside-a', shift: 'day' }, { key: `wellbuilt:${id}`, shift: 'night' }] };
    const result = await call(batch);
    expect(result.job).toMatchObject({ status: 'assigned', revision: 2, drivers: [
      { key: 'outside:outside-a', shift: 'day' }, { key: `wellbuilt:${id}`, shift: 'night' },
    ] });
    await expect(call(batch)).resolves.toMatchObject({ idempotent: true });
    expect(records.get('independent_dispatch_jobs/job-a/events/crew-a').afterDrivers).toHaveLength(2);
    await call({ ...create, jobId: 'job-b', requestId: 'create-b' });
    await expect(call({ ...batch, jobId: 'job-b', requestId: 'blocked-b', drivers: [
      { key: 'outside:outside-b', shift: 'day' }, { key: 'outside:outside-a', shift: 'night' },
    ] })).rejects.toThrow('driver_assignment_conflict');
    expect(records.get('independent_dispatch_jobs/job-b').revision).toBe(1);
    await expect(call({ ...batch, requestId: 'duplicate', expectedRevision: 2, drivers: [
      { key: 'outside:outside-c', shift: 'day' }, { key: 'outside:outside-c', shift: 'night' },
    ] })).rejects.toThrow('invalid_driver_selection');
    // An older job may already have a conflicting driver. That must not reject an unrelated new crew member.
    records.set('independent_dispatch_jobs/legacy-other', { ...records.get('independent_dispatch_jobs/job-a'),
      drivers: [{ key: 'outside:outside-a', name: 'outside-a', source: 'outside', shift: 'day', assignedAt: '2026-11-20T00:00:00.000Z' }] });
    await expect(call({ ...batch, requestId: 'add-unrelated', expectedRevision: 2,
      drivers: [{ key: 'outside:outside-c', shift: 'day' }] })).resolves.toMatchObject({ job: { revision: 3 } });
  });
  it('treats every crew member as busy on an overlapping job', async () => {
    for (const id of ['day-a', 'night-a']) records.set(`companies/company-a/external_drivers/${id}`,
      { companyId: 'company-a', externalDriverId: id, active: true, displayName: id });
    await call({ ...create, job: { ...details, ongoing: true } });
    await call({ ...create, jobId: 'job-b', requestId: 'create-b' });
    await call({ op: 'addDriver', jobId: 'job-a', requestId: 'assign-day', expectedRevision: 1, externalDriverId: 'day-a', shift: 'day' });
    await call({ op: 'addDriver', jobId: 'job-a', requestId: 'assign-night', expectedRevision: 2, externalDriverId: 'night-a', shift: 'night' });
    await expect(call({ op: 'addDriver', jobId: 'job-b', requestId: 'overlap-night', expectedRevision: 1, externalDriverId: 'night-a', shift: 'night' }))
      .rejects.toThrow('driver_assignment_conflict');
  });
  it('confirms a legacy driver shift without changing the rest of the assignment', async () => {
    records.set('companies/company-a/external_drivers/driver-a', { companyId: 'company-a', active: true, displayName: 'Driver A' });
    await call(create);
    await call({ op: 'assign', jobId: 'job-a', requestId: 'assign-a', expectedRevision: 1, externalDriverId: 'driver-a' });
    const confirmed = await call({ op: 'setDriverShift', jobId: 'job-a', requestId: 'shift-a', expectedRevision: 2,
      driverKey: 'outside:driver-a', shift: 'day' });
    expect(confirmed.job).toMatchObject({ revision: 3, status: 'assigned', drivers: [{ key: 'outside:driver-a', shift: 'day' }] });
    expect(records.get('independent_dispatch_jobs/job-a/events/shift-a')).toMatchObject({
      beforeDrivers: [{ key: 'outside:driver-a', shift: '' }], afterDrivers: [{ key: 'outside:driver-a', shift: 'day' }],
    });
    await expect(call({ op: 'setDriverShift', jobId: 'job-a', requestId: 'bad-shift', expectedRevision: 3,
      driverKey: 'outside:driver-a', shift: '' })).rejects.toThrow('invalid_driver_shift_change');
  });
  it('allows known nonoverlapping work and rejects an edit that creates a conflict', async () => {
    records.set('companies/company-a/external_drivers/driver-a', { companyId: 'company-a', active: true, displayName: 'Driver' });
    const first = { ...details, scheduledAt: '2099-11-23T08:00:00.000Z', estimatedEndAt: '2099-11-23T12:00:00.000Z' };
    const later = { ...details, scheduledAt: '2099-11-23T13:00:00.000Z', estimatedEndAt: '2099-11-23T20:00:00.000Z' };
    await call({ ...create, job: first });
    await call({ ...create, jobId: 'job-b', requestId: 'create-b', job: later });
    await call({ op: 'assign', jobId: 'job-a', requestId: 'assign-a', expectedRevision: 1, externalDriverId: 'driver-a' });
    await expect(call({ op: 'assign', jobId: 'job-b', requestId: 'before-start', expectedRevision: 1, externalDriverId: 'driver-a' }))
      .resolves.toMatchObject({ job: { status: 'assigned' } });
    await call({ op: 'status', jobId: 'job-a', requestId: 'start-a', expectedRevision: 2, status: 'in_progress' });
    await expect(call({ op: 'update', jobId: 'job-b', requestId: 'overlap-edit', expectedRevision: 2,
      job: { ...later, scheduledAt: '2099-11-23T11:00:00.000Z' } })).rejects.toThrow('driver_assignment_conflict');
  });
  it('lists only approved WellBuilt links and assigns a live linked profile without phone-app delivery', async () => {
    const id = 'wb-marcial';
    const link = { companyId: 'company-a', sourceCompanyId: 'liquid-gold', driverId: id,
      authUid: `driver_${id}`, displayName: 'Nitto–Anthony (Marcial Lebaron)', active: true };
    records.set(`companies/company-a/independent_dispatch_wb_drivers/${id}`, link);
    records.set('companies/company-a/independent_dispatch_wb_drivers/foreign', { ...link, driverId: 'foreign', companyId: 'company-b' });
    records.set('companies/company-a/independent_dispatch_wb_drivers/disabled', { ...link, driverId: 'disabled', active: false });
    profiles.set(`drivers/profiles/${id}`, { companyId: 'liquid-gold', active: true });
    const roster = (await call({ op: 'list' })).wbDrivers;
    expect(roster).toEqual(expect.arrayContaining([
      expect.objectContaining({ driverId: id, displayName: link.displayName, active: true }),
      expect.objectContaining({ driverId: 'disabled', active: false }),
    ]));
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
    const saved = { ...create, jobId: 'job-b', requestId: 'request-b', job: { ...oneOff, customer: "Bob's Hot Shot LLC",
      jobContactName: 'John Wick', jobContactRole: 'Company man', jobContactPhoneE164: '+17015550199' }, saveCustomer: true };
    await call(saved);
    expect(records.get('independent_dispatch_jobs/job-b').customerId).toBe('job_job-b');
    expect(records.get('companies/company-a/independent_dispatch_customers/job_job-b')).toMatchObject({
      companyId: 'company-a', name: "Bob's Hot Shot LLC", alternateNames: [], sectors: ['ltl'], active: true,
      contacts: [{ id: 'contact_job-b', name: 'John Wick', role: 'Company man', phoneE164: '+17015550199' }],
    });
    await expect(call(saved)).resolves.toMatchObject({ idempotent: true });
    expect([...records.keys()].filter(key => key.includes('independent_dispatch_customers'))).toHaveLength(1);
    await expect(call({ ...create, jobId: 'job-c', requestId: 'request-c', job: { ...oneOff, customer: "Bob's Hot Shot LLC" }, saveCustomer: true }))
      .rejects.toThrow('customer_name_conflict');
  });
  it('binds a job category to its customer and sector', async () => {
    const category = { id: 'rig-work', name: 'Rig Work', sector: 'water-hauling',
      sourceChannels: ['ExxonMobil - RIG WORK'], assets: ['H&P Rig 429', 'H&P Rig 640'] };
    records.set('companies/company-a/independent_dispatch_customers/exxon', {
      companyId: 'company-a', name: 'ExxonMobil', active: true, sectors: ['water-hauling'], workCategories: [category],
    });
    const water = { ...details, customerId: 'exxon', sector: 'water-hauling',
      sectorFields: { waterType: 'Fresh water', volumeBbl: '120' } };
    await call({ ...create, job: { ...water, categoryId: 'rig-work', asset: 'H&P Rig 429' } });
    expect(records.get('independent_dispatch_jobs/job-a')).toMatchObject({ customer: 'ExxonMobil',
      categoryId: 'rig-work', asset: 'H&P Rig 429' });
    await expect(call({ ...create, jobId: 'job-b', requestId: 'request-b', job: { ...water, categoryId: 'mongoose' } }))
      .rejects.toThrow('customer_category_unavailable');
    records.set('companies/company-a/independent_dispatch_customers/other', {
      companyId: 'company-a', name: 'Other', active: true, sectors: ['water-hauling'],
      workCategories: [{ ...category, id: 'mongoose' }],
    });
    await expect(call({ ...create, jobId: 'job-c', requestId: 'request-c', job: { ...water, categoryId: 'mongoose' } }))
      .rejects.toThrow('customer_category_unavailable');
    records.set('companies/company-a/independent_dispatch_customers/exxon', {
      companyId: 'company-a', name: 'ExxonMobil', active: true, sectors: ['water-hauling'], workCategories: [],
    });
    await expect(call({ op: 'update', jobId: 'job-a', requestId: 'archived-edit', expectedRevision: 1,
      job: { ...water, categoryId: 'rig-work', asset: 'H&P Rig 429', notes: 'Updated after category removal' } }))
      .resolves.toMatchObject({ job: { revision: 2, categoryId: 'rig-work' } });
    await expect(call({ op: 'update', jobId: 'job-a', requestId: 'archived-clear', expectedRevision: 2,
      job: { ...water, categoryId: '', asset: '' } }))
      .resolves.toMatchObject({ job: { revision: 3, categoryId: '', asset: '' } });
  });
});

describe('Independent Dispatch driver profiles', () => {
  it('saves a review note without changing assignment eligibility, with revision history and tenant checks', async () => {
    const linked = { companyId: 'company-a', driverId: 'wb-marcial', displayName: 'Marcial', active: true };
    records.set('companies/company-a/independent_dispatch_wb_drivers/wb-marcial', linked);
    records.set('companies/company-a/independent_dispatch_customers/mongoose', { companyId: 'company-a', active: true, name: 'Mongoose' });
    const profile = { driverKey: 'wellbuilt:wb-marcial', primaryCustomerId: 'mongoose',
      phoneE164: '+17015550123', whatsappName: 'Marcial WA', standingWork: 'Regular route stays with Marcial.', sideJobs: 'yes', shiftPreference: 'day',
      operatorNotes: [{ customerId: 'mongoose', dispatchNote: 'Review with management.', operatorFeedback: '', reviewPending: true }] };
    const saved = await profileCall({ op: 'save', profile, expectedRevision: 0 });
    expect(saved.profile).toMatchObject({ ...profile, revision: 1, companyId: 'company-a' });
    expect(records.get('companies/company-a/independent_dispatch_driver_profiles/wellbuilt__wb-marcial/revisions/1'))
      .toMatchObject({ actorUid: 'dispatcher', revision: 1 });
    expect((await profileCall({ op: 'list' })).profiles).toHaveLength(1);
    await expect(profileCall({ op: 'save', profile, expectedRevision: 0 })).rejects.toThrow('driver_profile_changed');
    await expect(profileCall({ op: 'save', profile: { ...profile, primaryCustomerId: 'foreign' }, expectedRevision: 1 }))
      .rejects.toThrow('customer_not_in_company_directory');
    await expect(profileCall({ op: 'save', profile: { ...profile, shiftPreference: 'overnight' }, expectedRevision: 1 }))
      .rejects.toThrow('invalid_shift_preference');
    expect(records.get('companies/company-a/independent_dispatch_driver_profiles/wellbuilt__wb-marcial').revision).toBe(1);
  });
  it('requires the package and a driver in the same company roster', async () => {
    const profile = { driverKey: 'outside:isaac', primaryCustomerId: '', standingWork: '', sideJobs: 'ask', operatorNotes: [] };
    records.set('companies/company-a', { activePackages: ['water-hauling'] });
    await expect(profileCall({ op: 'list' })).rejects.toThrow('independent_dispatch_package_inactive');
    records.set('companies/company-a', { activePackages: ['independent-dispatch'] });
    records.set('companies/company-a/external_drivers/isaac', { companyId: 'company-b', externalDriverId: 'isaac', active: true });
    await expect(profileCall({ op: 'save', profile, expectedRevision: 0 })).rejects.toThrow('driver_not_in_company_roster');
    records.set('companies/company-a/external_drivers/isaac', { companyId: 'company-a', externalDriverId: 'isaac', active: true, displayName: 'Isaac', phoneE164: '+17015550123', channels: ['sms'] });
    await profileCall({ op: 'save', profile, expectedRevision: 0 });
    await profileCall({ op: 'save', profile: { ...profile, phoneE164: '+17015550456', whatsappName: 'Isaac WA' }, expectedRevision: 1 });
    expect(records.get('companies/company-a/external_drivers/isaac').phoneE164).toBe('+17015550456');
    await profileCall({ op: 'save', profile: { ...profile, phoneE164: '', whatsappName: '' }, expectedRevision: 2 });
    expect(records.get('companies/company-a/external_drivers/isaac')).toMatchObject({ phoneE164: '', channels: [] });
    await call(create);
    await expect(call({ op: 'assign', jobId: 'job-a', requestId: 'assign-isaac', expectedRevision: 1, externalDriverId: 'isaac' }))
      .resolves.toMatchObject({ job: { status: 'assigned' } });
  });
});
