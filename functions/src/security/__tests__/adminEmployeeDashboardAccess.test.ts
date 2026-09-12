jest.mock('firebase-functions/v2/https', () => ({ onCall: (_: unknown, fn: unknown) => fn, HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
jest.mock('firebase-admin', () => ({ database: jest.fn(), auth: jest.fn() }));
jest.mock('../adminAuth', () => ({ requireManageDrivers: jest.fn() }));
jest.mock('../audit', () => ({ writeSecurityAudit: jest.fn() }));
import * as admin from 'firebase-admin';
import { requireManageDrivers } from '../adminAuth';
import { adminEmployeeDashboardAccess } from '../adminEmployeeDashboardAccess';
let records: Map<string, any>, accounts: Map<string, any>, auth: any;
const base = { driverId: 'canonical-id', email: 'employee@example.com', roles: ['admin', 'dispatch'], generateSetupLink: true };
const invoke = (data: any = {}) => (adminEmployeeDashboardAccess as unknown as (request: any) => Promise<any>)({ auth: { uid: 'actor' }, data: { ...base, ...data } });
beforeEach(() => {
  jest.clearAllMocks(); accounts = new Map();
  records = new Map([['drivers/profiles/canonical-id', { active: true, companyId: 'company-a', companyName: 'Company A', displayName: 'Employee', roles: ['driver', 'admin'] }]]);
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'actor', roles: ['admin'], companyId: 'company-a', isPlatformAdmin: false });
  (admin.database as unknown as jest.Mock).mockReturnValue({ ref: (key: string) => ({
    update: async (patch: any) => records.set(key, { ...records.get(key), ...patch }),
    once: async () => ({ val: () => records.get(key) || null }),
    transaction: async (fn: (v: any) => any) => {
      let value = fn(null);
      if (value === undefined) return { committed: false };
      if (records.has(key)) value = fn(records.get(key));
      if (value !== undefined && value !== null) records.set(key, value);
      return { committed: value !== undefined };
    },
  }) });
  auth = {
    getUserByEmail: jest.fn(async (email: string) => {
      if (accounts.has(email)) return accounts.get(email);
      throw { code: 'auth/user-not-found' };
    }),
    createUser: jest.fn(async (data: any) => { accounts.set(data.email, { ...data }); return data; }),
    updateUser: jest.fn(async (uid: string, patch: any) => { const account = [...accounts.values()].find(a => a.uid === uid); Object.assign(account, patch); return account; }),
    generatePasswordResetLink: jest.fn(async () => 'https://example.com/test-only-password-link'),
  };
  (admin.auth as unknown as jest.Mock).mockReturnValue(auth);
});
test('links the same canonical employee to company-scoped email login, leaving app roles intact', async () => {
  const result = await invoke();
  expect(result.ok).toBe(true);
  expect(result.setupLink).toContain('test-only');
  expect(records.get('users/dashboard_canonical-id')).toMatchObject({ driverId: 'canonical-id', companyId: 'company-a', roles: ['admin', 'dispatch'], role: 'admin' });
  expect(records.get('drivers/profiles/canonical-id')).toMatchObject({ dashboardUid: 'dashboard_canonical-id', roles: ['driver', 'admin'] });
  expect([...records.keys()].some(k => k.includes('approved'))).toBe(false);
  expect(auth.createUser.mock.calls[0][0].disabled).toBe(true);
  expect(auth.updateUser).toHaveBeenCalledWith('dashboard_canonical-id', { disabled: false });
});
test('repeat uses the same Auth account and role changes keep the canonical link', async () => {
  await invoke();
  await invoke({ roles: ['manager'], generateSetupLink: false });
  expect(auth.createUser).toHaveBeenCalledTimes(1);
  expect(auth.generatePasswordResetLink).toHaveBeenCalledTimes(1);
  expect(records.get('users/dashboard_canonical-id')).toMatchObject({ role: 'manager', roles: ['manager'], driverId: 'canonical-id' });
});
test('cross-company and ordinary managers cannot grant dashboard access', async () => {
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'actor', roles: ['admin'], companyId: 'company-b', isPlatformAdmin: false });
  await expect(invoke()).rejects.toThrow('outside your company');
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'actor', roles: ['manager'], companyId: 'company-a', isPlatformAdmin: false });
  await expect(invoke()).rejects.toThrow('administrator');
  expect(auth.createUser).not.toHaveBeenCalled();
});
test('company admin cannot elevate to IT, but platform admin can grant company-scoped IT', async () => {
  await expect(invoke({ roles: ['it'] })).rejects.toThrow('owner or WB');
  (requireManageDrivers as jest.Mock).mockResolvedValue({ uid: 'actor', roles: ['it'], isPlatformAdmin: true });
  await invoke({ roles: ['it'] });
  expect(records.get('users/dashboard_canonical-id').companyId).toBe('company-a');
});
test.each([
  { role: 'it' },
  { companyId: 'company-b', role: 'admin' },
  { companyId: 'company-a', driverId: 'another-driver', role: 'admin' },
  { companyId: 'company-a', driverHash: 'legacy-key', role: 'admin' },
])('unrelated email account is never overwritten: %p', async existing => {
  accounts.set(base.email, { uid: 'existing', email: base.email });
  records.set('users/existing', existing);
  await expect(invoke()).rejects.toThrow('unrelated');
  expect(records.get('users/existing')).toEqual(existing);
  expect(records.get('drivers/profiles/canonical-id').dashboardUid).toBeUndefined();
});
test('explicit linking may reuse an unlinked dashboard account in the same company', async () => {
  accounts.set(base.email, { uid: 'existing', email: base.email });
  records.set('users/existing', { companyId: 'company-a', role: 'viewer' });
  await invoke(); expect(records.get('users/existing').driverId).toBe('canonical-id');
  expect(auth.createUser).not.toHaveBeenCalled();
});
test('inactive employee and invalid payload cannot provision', async () => {
  await expect(invoke({ roles: ['superuser'] })).rejects.toThrow('valid dashboard roles');
  await expect(invoke({ email: 'bad' })).rejects.toThrow('valid email');
  records.get('drivers/profiles/canonical-id').active = false;
  await expect(invoke()).rejects.toThrow('inactive'); expect(auth.createUser).not.toHaveBeenCalled();
});
test('setup link failure reports linked account accurately and supports retry', async () => {
  auth.generatePasswordResetLink.mockRejectedValue(new Error('mail service failure'));
  const result = await invoke(); expect(result.ok).toBe(true); expect(result.setupLink).toBeNull(); expect(result.setupLinkError).toContain('could not be generated');
});
test('existing employee link cannot be reassigned to another email', async () => {
  await invoke(); await expect(invoke({ email: 'another@example.com' })).rejects.toThrow('already has a dashboard login');
  expect(auth.createUser).toHaveBeenCalledTimes(1);
});
test('activation failure leaves new Auth account disabled and safely retries', async () => {
  auth.updateUser.mockRejectedValueOnce(new Error('activation unavailable'));
  await expect(invoke()).rejects.toThrow('activation unavailable');
  expect(accounts.get(base.email).disabled).toBe(true);
  expect(records.get('users/dashboard_canonical-id')).toMatchObject({ companyId: 'company-a', dashboardProvisioningPending: true });
  await expect(invoke()).resolves.toMatchObject({ ok: true });
  expect(auth.createUser).toHaveBeenCalledTimes(1);
  expect(accounts.get(base.email).disabled).toBe(false);
});
test('administratively disabled completed account is not re-enabled by role editing', async () => {
  await invoke(); accounts.get(base.email).disabled = true;
  await expect(invoke()).rejects.toThrow('account is disabled');
  expect(auth.updateUser).toHaveBeenCalledTimes(1);
});
