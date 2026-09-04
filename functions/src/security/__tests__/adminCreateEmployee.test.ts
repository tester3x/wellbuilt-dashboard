jest.mock('firebase-functions/v2/https', () => ({ onCall: (_: unknown, fn: unknown) => fn, HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
jest.mock('firebase-admin', () => ({ firestore: jest.fn(), database: jest.fn() }));
jest.mock('../adminAuth', () => ({ requireManageDrivers: jest.fn() }));
jest.mock('../audit', () => ({ writeSecurityAudit: jest.fn() }));
jest.mock('../operational/ensureEmptyShiftAuthority', () => ({ ensureInitializedEmptyShiftAuthority: jest.fn(), assertEnsureAuthorityOk: (r: any) => { if (r.decision.action === 'refuse') throw new Error('authority refused'); } }));
jest.mock('../passcode', () => ({
  ...jest.requireActual('../passcode'),
  hashPasscodeScrypt: async (v: string) => ({ testHash: v }),
  verifyPasscodeScrypt: async (v: string, hash: any) => v === hash.testHash,
}));
import * as admin from 'firebase-admin';
import { requireManageDrivers } from '../adminAuth';
import { ensureInitializedEmptyShiftAuthority } from '../operational/ensureEmptyShiftAuthority';
import { adminCreateEmployee } from '../adminCreateEmployee';

let docs: Map<string, any>, profiles: Map<string, any>, failProfile: boolean;
const requestId = '11111111-1111-4111-8111-111111111111';
const base = { requestId, displayName: 'New Driver', legalName: 'New Driver Legal', companyId: 'company-a', passcode: 'unique-passcode' };
const invoke = (extra: Record<string, unknown> = {}) => (adminCreateEmployee as unknown as (r: unknown) => Promise<any>)({ auth: { uid: 'admin' }, data: { ...base, ...extra } });
beforeEach(() => {
  jest.clearAllMocks(); failProfile = false;
  docs = new Map([['companies/company-a', { name: 'Company A', status: 'active' }]]); profiles = new Map();
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'admin', companyId: 'company-a', isPlatformAdmin: false });
  (ensureInitializedEmptyShiftAuthority as jest.Mock).mockResolvedValue({ decision: { action: 'create' } });
  const snap = (key: string) => ({ exists: docs.has(key), data: () => docs.get(key) });
  const reference = (key: string) => ({ key, get: async () => snap(key) });
  (admin.firestore as unknown as jest.Mock).mockReturnValue({
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`) }),
    runTransaction: async (fn: (t: any) => Promise<any>) => {
      const writes: (() => void)[] = [];
      const value = await fn({ get: async (r: any) => snap(r.key),
        create: (r: any, value: any) => { if (docs.has(r.key)) throw new Error('duplicate'); writes.push(() => docs.set(r.key, value)); },
        update: (r: any, value: any) => writes.push(() => docs.set(r.key, { ...docs.get(r.key), ...value })),
      });
      writes.forEach(fn => fn()); return value;
    },
  });
  (admin.database as unknown as jest.Mock).mockReturnValue({ ref: (key: string) => ({ transaction: async (fn: (v: any) => any) => {
    if (failProfile) throw new Error('profile unavailable');
    const first = fn(null);
    if (first === undefined) return { committed: false, snapshot: { exists: () => profiles.has(key) } };
    const value = profiles.has(key) ? fn(profiles.get(key)) : first;
    if (value !== undefined) { if (value === null) profiles.delete(key); else profiles.set(key, value); }
    return { committed: value !== undefined, snapshot: { exists: () => profiles.has(key) } };
  } }) });
});
const credential = () => [...docs.entries()].find(([key]) => key.startsWith('driver_credentials/'))?.[1];
test('company admin creates a driver-only secure account with empty access', async () => {
  const result = await invoke();
  expect(result.ok).toBe(true);
  expect(profiles.get(`drivers/profiles/${result.driverId}`)).toMatchObject({ active: true, companyId: 'company-a', roles: ['driver'], assignedRoutes: [], assignedWells: [] });
  expect(credential()).toMatchObject({ active: true, mustResetPasscode: false });
  expect(ensureInitializedEmptyShiftAuthority).toHaveBeenCalled();
  expect([...profiles.keys()].every(k => k.startsWith('drivers/profiles/'))).toBe(true);
});
test('company admin cannot create cross-company or inject elevated roles', async () => {
  await expect(invoke({ companyId: 'company-b' })).rejects.toThrow('own company');
  await expect(invoke({ roles: ['admin'] })).rejects.toThrow('Unexpected');
  expect(credential()).toBeUndefined();
});
test('unbound non-platform caller is refused', async () => {
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'admin', isPlatformAdmin: false });
  await expect(invoke()).rejects.toThrow('own company');
});
test('platform admin may select a company', async () => {
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'admin', isPlatformAdmin: true });
  await expect(invoke()).resolves.toMatchObject({ ok: true });
});
test('duplicate name never resets or adopts an existing account', async () => {
  docs.set('driver_name_index/new driver', { driverId: 'existing' });
  await expect(invoke()).rejects.toThrow('already registered');
  expect(profiles.size).toBe(0);
  expect(credential()).toBeUndefined();
});
test('profile failure leaves disabled credentials; same request resumes', async () => {
  failProfile = true; await expect(invoke()).rejects.toThrow('profile unavailable');
  expect(credential().active).toBe(false);
  failProfile = false; const result = await invoke();
  expect(result.ok).toBe(true);
  expect([...docs.keys()].filter(k => k.startsWith('driver_credentials/'))).toHaveLength(1);
});
test('authority failure never activates credentials', async () => {
  (ensureInitializedEmptyShiftAuthority as jest.Mock).mockResolvedValue({ decision: { action: 'refuse' } });
  await expect(invoke()).rejects.toThrow('authority refused');
  expect(credential().active).toBe(false);
});
test('completed retry returns same ID without resetting changed passcode or permissions', async () => {
  const first = await invoke(); credential().passcode = { testHash: 'changed-later' };
  profiles.get(`drivers/profiles/${first.driverId}`).assignedRoutes = ['Existing'];
  const second = await invoke();
  expect(second.driverId).toBe(first.driverId); expect(second.alreadyCreated).toBe(true);
  expect(credential().passcode.testHash).toBe('changed-later');
  expect(profiles.get(`drivers/profiles/${first.driverId}`).assignedRoutes).toEqual(['Existing']);
});
test('partial retry cannot change employee or passcode', async () => {
  failProfile = true; await expect(invoke()).rejects.toThrow(); failProfile = false;
  await expect(invoke({ legalName: 'Different' })).rejects.toThrow('same employee details');
  await expect(invoke({ passcode: 'different-passcode' })).rejects.toThrow('original passcode');
});
test('missing company and malformed fields do not create accounts', async () => {
  docs.clear(); await expect(invoke()).rejects.toThrow('missing or inactive');
  await expect(invoke({ passcode: '123' })).rejects.toThrow('at least 6');
  expect(credential()).toBeUndefined();
});
