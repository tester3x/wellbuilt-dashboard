let mockData: any;
const clone = (v: any) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const mockRef = (path: string) => {
  const parts = path.split('/');
  const read = () => parts.reduce((obj, key) => obj?.[key], mockData);
  const snapshot = () => ({ val: () => clone(read()), exists: () => read() != null });
  return {
    once: async () => snapshot(), on: (_: string, cb: any) => cb(snapshot()), off: jest.fn(),
    transaction: async (fn: any) => {
      const value = fn(clone(read()));
      if (value === undefined) return { committed: false, snapshot: snapshot() };
      const parent = parts.slice(0, -1).reduce((obj, key) => obj[key], mockData);
      parent[parts.at(-1)!] = value;
      return { committed: true, snapshot: snapshot() };
    },
  };
};
jest.mock('firebase-admin', () => ({ database: () => ({ ref: mockRef }) }));
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_: any, handler: any) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
jest.mock('../../requireDriverAuth', () => ({ requireSecureDriver: async (request: any) => {
  if (!request.auth?.uid || !request.auth.token?.driverId) throw Error('unauthenticated');
  return { uid: request.auth.uid, driverId: request.auth.token.driverId };
} }));
jest.mock('../../canonicalDriverAuthority', () => ({ productionCanonicalDriverReaders: () => ({}),
  loadCanonicalDriverAuthority: async (id: string) => {
    const p = mockData.drivers.profiles[id];
    return p ? { companyId: p.companyId, active: p.active !== false && p.credentialsActive !== false } : null;
  } }));
jest.mock('../../trustedStaffAuthority', () => ({ TRUSTED_CAPABILITY_MANAGE_DRIVERS: 'manageDrivers',
  requireTrustedCompanyCapability: async (uid: string) => {
    if (uid !== 'trusted-staff') throw Error('staff_required');
    return { uid, companyId: 'company-a' };
  } }));
import { getWbmTankInfo, saveWbmTankInfo } from '../tankInfoCallables';
import { staffGetPrimaryRouteAssignments, staffWritePrimaryRouteAssignment } from '../staffWritePrimaryRouteAssignment';
const getInfo = getWbmTankInfo as any, saveInfo = saveWbmTankInfo as any;
const writePrimary = staffWritePrimaryRouteAssignment as any, getPrimary = staffGetPrimaryRouteAssignments as any;
const request = (driver: string, data: any) => ({ auth: { uid: 'uid-' + driver, token: { driverId: driver } }, data });
const op = { wellName: 'Example', operationId: 'operation-1234567890123456', expectedRevision: 0, patch: { activeTanks: 2 } };
beforeEach(() => {
  mockData = { drivers: { profiles: {
    primary: { companyId: 'company-a', active: true, assignedRoutes: ['Route A', 'Route B'], primaryRoutes: ['Route A'], displayName: 'Primary' },
    helper: { companyId: 'company-a', active: true, assignedRoutes: ['Route A'], displayName: 'Helper' },
    admin: { companyId: 'company-a', active: true, isAdmin: true },
    foreign: { companyId: 'other-company', active: true, isAdmin: true },
  } }, well_config: { Example: { companyId: 'company-a', route: 'Route A', tanks: 4, numTanks: 4,
    activeTanks: 4, bblPerFoot: 134.4, ndicApiNo: '00-000-00000-00-00', tankHeight: 30.25 } } };
});
test('view is company/assignment scoped and edit authority comes from the canonical profile, not the request', async () => {
  expect(await getInfo(request('helper', { wellName: 'Example' }))).toMatchObject({ canEdit: false });
  await expect(saveInfo(request('helper', op))).rejects.toThrow('tank_info_edit_forbidden');
  await expect(getInfo(request('foreign', { wellName: 'Example' }))).rejects.toThrow('well_not_assigned');
  await expect(saveInfo(request('primary', { ...op, isAdmin: true }))).rejects.toThrow('invalid_request');
  expect(mockData.well_config.Example.tankInfoRevision).toBeUndefined();
});
test('a committed edit has a durable audited receipt; retry after lost acknowledgement does not apply twice', async () => {
  const first = await saveInfo(request('primary', op));
  expect(first).toMatchObject({ ok: true, operationId: op.operationId, config: { activeTanks: 2, bblPerFoot: 67.2, totalTanks: 4, tankInfoRevision: 1 } });
  const saved = clone(mockData.well_config.Example);
  expect(saved.tankInfoEdits[op.operationId].before.numTanks).toBe(4);
  const retry = await saveInfo(request('primary', op));
  expect(retry.config.tankInfoRevision).toBe(1); expect(mockData.well_config.Example).toEqual(saved);
  expect(first.config.tankInfoEdits).toBeUndefined();
});
test('stale revisions and reused operation identities cannot overwrite somebody else’s setup', async () => {
  await saveInfo(request('primary', op));
  await expect(saveInfo(request('admin', { ...op, operationId: 'operation-9999999999999999' }))).rejects.toThrow('tank_info_conflict');
  await expect(saveInfo(request('primary', { ...op, patch: { activeTanks: 3 } }))).rejects.toThrow('operation_reused');
  expect(mockData.well_config.Example.activeTanks).toBe(2);
});
test('revoked primary cannot edit again but can confirm an already applied own operation', async () => {
  await saveInfo(request('primary', op)); mockData.drivers.profiles.primary.primaryRoutes = [];
  expect((await saveInfo(request('primary', op))).operationId).toBe(op.operationId);
  await expect(saveInfo(request('primary', { ...op, expectedRevision: 1, operationId: 'operation-9999999999999999' }))).rejects.toThrow('tank_info_edit_forbidden');
});
test('read-only NDIC changes, invalid setup, and disabled credentials are rejected without a receipt', async () => {
  await expect(saveInfo(request('primary', { ...op, patch: { ndicApiNo: 'changed' } }))).rejects.toThrow('invalid_field');
  await expect(saveInfo(request('primary', { ...op, patch: { activeTanks: 5 } }))).rejects.toThrow('active_exceeds_total');
  mockData.drivers.profiles.primary.credentialsActive = false;
  await expect(saveInfo(request('primary', op))).rejects.toThrow('driver_inactive');
  expect(mockData.well_config.Example.tankInfoEdits).toBeUndefined();
});
test('only trusted company staff can designate primaries; multiple primaries and viewing assignments are preserved', async () => {
  const data = { driverId: 'helper', primaryRoutes: ['Route A'], primaryAllRoutes: false, expectedRevision: 0 };
  await expect(writePrimary(request('primary', data))).rejects.toThrow('staff_required');
  const staff = { auth: { uid: 'trusted-staff' }, data };
  expect(await writePrimary(staff)).toMatchObject({ ok: true, primaryRoutes: ['Route A'] });
  expect(mockData.drivers.profiles.primary.primaryRoutes).toEqual(['Route A']);
  expect(mockData.drivers.profiles.helper.assignedRoutes).toEqual(['Route A']);
  const catalog = await getPrimary({ auth: staff.auth, data: {} });
  expect(catalog.profiles.foreign).toBeUndefined();
  expect(catalog.profiles.helper.displayName).toBeUndefined();
  await expect(writePrimary({ ...staff, data: { ...data, driverId: 'foreign' } })).rejects.toThrow('driver_unavailable');
});
