jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_: unknown, handler: unknown) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
jest.mock('firebase-admin', () => ({ database: jest.fn() }));
jest.mock('../adminAuth', () => ({ requireManageDrivers: jest.fn() }));
jest.mock('../audit', () => ({ writeSecurityAudit: jest.fn() }));
import * as admin from 'firebase-admin';
import { requireManageDrivers } from '../adminAuth';
import { adminEditDriverProfile, validateDriverEdits } from '../adminEditDriverProfile';
import { readFileSync } from 'fs';
import { join } from 'path';
let current: any;
const invoke = () => (adminEditDriverProfile as unknown as (r: unknown) => Promise<unknown>)({ auth: { uid: 'admin' }, data: { driverId: 'driver-id', edits: { phone: ' 555 ' } } });
beforeEach(() => {
  jest.clearAllMocks();
  current = { companyId: 'company-a', assignedRoutes: ['Route'], profile: { truckNumber: '12' } };
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'admin', companyId: 'company-a', isPlatformAdmin: false });
  (admin.database as unknown as jest.Mock).mockReturnValue({ ref: () => ({ transaction: async (fn: (v: unknown) => unknown) => {
    // SDK's cold-cache callback precedes the server value. Undefined aborts
    // immediately (the original bug); null must allow the server retry.
    const initial = fn(null);
    if (initial === undefined) return { committed: false };
    const next = fn(current); if (next !== undefined) current = next; return { committed: next !== undefined };
  } }) });
});
test('rejects permissions, company and arbitrary field injection', () => {
  for (const key of ['active', 'roles', 'isAdmin', 'companyId', 'displayName', 'assignedRoutes', 'profile/phone']) expect(() => validateDriverEdits({ [key]: 'x' })).toThrow();
  expect(() => validateDriverEdits({ phone: 123 })).toThrow();
  expect(() => validateDriverEdits({})).toThrow();
});
test('merges both profile readers without disturbing assignments', async () => {
  await expect(invoke()).resolves.toEqual({ ok: true });
  expect(current).toEqual({ companyId: 'company-a', assignedRoutes: ['Route'], phone: '555', profile: { truckNumber: '12', phone: '555' } });
});
test('cross-company edits are refused', async () => {
  current.companyId = 'company-b'; await expect(invoke()).rejects.toThrow('outside your company');
  expect(current.phone).toBeUndefined();
});
test('missing driver is not recreated', async () => {
  current = null; await expect(invoke()).rejects.toThrow('no longer exists'); expect(current).toBeNull();
});
test('platform admin may edit an unassigned profile', async () => {
  current.companyId = undefined;
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'admin', isPlatformAdmin: true });
  await expect(invoke()).resolves.toEqual({ ok: true });
});
test('UI groups canonical drivers and uses in-page delete confirmation', () => {
  const source = readFileSync(join(__dirname, '../../../../src/components/admin/DriversTab.tsx'), 'utf8');
  expect(source).not.toContain('window.prompt');
  expect(source).toContain('<details key={companyId}');
  expect(source).toContain('<details key={d.driverId}');
  expect(source).toContain('Type DELETE to confirm');
  expect(source).toContain('Edit company');
  expect(source).toContain('if (!companyTarget._canonicalOnly) await update');
});
