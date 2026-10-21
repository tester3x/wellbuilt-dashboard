jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } },
  onCall: (_options: unknown, handler: unknown) => handler,
}));
jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
jest.mock('../canonicalDriverAuthority', () => ({ loadCanonicalDriverAuthority: jest.fn(), productionCanonicalDriverReaders: () => ({}) }));
jest.mock('../adminAuth', () => ({ requireRegisteredDashboardUser: jest.fn() }));
jest.mock('../trustedStaffAuthority', () => ({ requireTrustedCompanyCapability: jest.fn(), TRUSTED_CAPABILITY_MANAGE_DRIVERS: 'manageDrivers' }));
import * as admin from 'firebase-admin';
import { loadCanonicalDriverAuthority } from '../canonicalDriverAuthority';
import { requireRegisteredDashboardUser } from '../adminAuth';
import { requireTrustedCompanyCapability } from '../trustedStaffAuthority';
import { reportDriverSyncAlert, adminListSyncAlerts, parseSyncAlertReport, syncAlertId, syncAlertTransition } from '../officeSyncAlerts';

const report = { operationId: 'safeOps:stage1', kind: 'dispatchStage', resourceId: 'job1', state: 'open', reason: 'repeated_delivery_failure', attempts: 5, createdAtMs: 1 };
const request = () => ({ auth: { uid: 'sdk-driver', token: { kind: 'driver', driverId: 'driver1', companyId: 'company1', app: 'wbt' } }, data: { ...report } });
const documents = new Map<string, Record<string, unknown>>();
const writes: unknown[] = [];
let resource: Record<string, unknown> | undefined;
const filters: unknown[] = [];
beforeEach(() => {
  jest.clearAllMocks(); documents.clear(); writes.length = 0; filters.length = 0;
  resource = { companyId: 'company1', driverId: 'driver1' };
  (loadCanonicalDriverAuthority as jest.Mock).mockResolvedValue({ active: true, companyId: 'company1', driverId: 'driver1', displayName: 'Test Driver' });
  (requireRegisteredDashboardUser as jest.Mock).mockResolvedValue({ isPlatformAdmin: false });
  (requireTrustedCompanyCapability as jest.Mock).mockResolvedValue({ uid: 'staff', companyId: 'company1' });
  const snap = (id: string) => ({ exists: documents.has(id), data: () => documents.get(id) });
  const query: any = { where: (...args: unknown[]) => { filters.push(args); return query; }, limit: () => query, get: async () => ({ docs: [] }) };
  (admin.firestore as unknown as jest.Mock).mockReturnValue({
    collection: (name: string) => ({ ...query, doc: (id: string) => ({ id, get: async () => name === 'office_sync_alerts' ? snap(id) : { exists: !!resource, data: () => resource } }) }),
    runTransaction: async (work: any) => work({ get: async (ref: any) => snap(ref.id), set: (ref: any, data: any) => { documents.set(ref.id, data); writes.push(data); } }),
  });
});
test('reports reject injected authority, new routine updates and unsupported kinds', () => {
  expect(() => parseSyncAlertReport({ ...report, companyId: 'foreign' }, 1000000)).toThrow();
  expect(() => parseSyncAlertReport({ ...report, attempts: 4 }, 1000000)).toThrow();
  expect(() => parseSyncAlertReport({ ...report, createdAtMs: 900000 }, 1000000)).toThrow();
  expect(() => parseSyncAlertReport({ ...report, kind: 'run-anything' }, 1000000)).toThrow();
  expect(parseSyncAlertReport({ ...report, reason: 'rejected_update', attempts: 1 }, 1000000)).toMatchObject({ attempts: 1 });
});
test('dedup identity includes company, driver and exact operation; resolved incidents never reopen', () => {
  expect(syncAlertId('a', 'b', 'c')).not.toBe(syncAlertId('a', 'bc', ''));
  expect(syncAlertId('a', 'b', 'c')).not.toBe(syncAlertId('x', 'b', 'c'));
  expect(syncAlertTransition({ status: 'resolved' }, 'open')).toBe('unchanged');
});
test('repeated reports create one incident, recovery resolves it, and late failures cannot reopen it', async () => {
  await (reportDriverSyncAlert as any)(request());
  await (reportDriverSyncAlert as any)(request());
  expect(writes).toHaveLength(1);
  await (reportDriverSyncAlert as any)({ ...request(), data: { ...report, state: 'resolved' } });
  await (reportDriverSyncAlert as any)(request());
  expect(writes).toHaveLength(2);
  expect([...documents.values()][0].status).toBe('resolved');
});
test('ambiguous open delivery followed by resolution before any acknowledged open still creates a tombstone', async () => {
  await (reportDriverSyncAlert as any)({ ...request(), data: { ...report, state: 'resolved' } });
  await (reportDriverSyncAlert as any)(request());
  expect(writes).toHaveLength(1);
  expect([...documents.values()][0].status).toBe('resolved');
});
test('revoked, foreign-company, wrong-app and foreign-resource reports cannot enter an office inbox', async () => {
  await expect((reportDriverSyncAlert as any)({ data: report })).rejects.toThrow('driver_required');
  (loadCanonicalDriverAuthority as jest.Mock).mockResolvedValueOnce({ active: false });
  await expect((reportDriverSyncAlert as any)(request())).rejects.toThrow('driver_scope_changed');
  const foreign = request(); foreign.auth.token.companyId = 'other';
  await expect((reportDriverSyncAlert as any)(foreign)).rejects.toThrow('driver_scope_changed');
  const wrongApp = request(); wrongApp.auth.token.app = 'etc';
  await expect((reportDriverSyncAlert as any)(wrongApp)).rejects.toThrow('driver_scope_changed');
  resource = { companyId: 'other', driverId: 'someone-else' };
  await expect((reportDriverSyncAlert as any)(request())).rejects.toThrow('foreign_resource');
  expect(writes).toHaveLength(0);
});
test('staff reads are server-company-scoped, capability-checked, and reject client role injection', async () => {
  await expect((adminListSyncAlerts as any)({ auth: { uid: 'staff' }, data: { companyId: 'other' } })).rejects.toThrow('foreign_company');
  await expect((adminListSyncAlerts as any)({ auth: { uid: 'staff' }, data: { role: 'admin' } })).rejects.toThrow('invalid_scope');
  await (adminListSyncAlerts as any)({ auth: { uid: 'staff' }, data: {} });
  expect(filters).toContainEqual(['companyId', '==', 'company1']);
  expect(filters).toContainEqual(['status', '==', 'open']);
  expect(requireTrustedCompanyCapability).toHaveBeenCalledWith('staff', 'manageDrivers');
});
