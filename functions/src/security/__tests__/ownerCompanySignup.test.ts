import { createOwnerCompany, getOwnerCompanySetup, ownerCompanyId, ownerFreePlan, ownerSignupInput, OWNER_CAPABILITIES } from '../ownerCompanySignup';
import { driverAuthUid } from '../tokenMint';
import { verifyPasscodeScrypt } from '../passcode';
import { TRUSTED_CAPABILITY_ALLOWLIST } from '../trustedStaffAuthority';
import { parseCompanyContract } from '../../admin/companyContract';
import { decideAppEntitlementAuthorization } from '../../sso/appEntitlementAuthorization';

const mockDocuments = new Map<string, any>();
const mockRealtime = new Map<string, any>();
let mockFailurePath = '';
let mockProvider = 'password';
let mockDisabled = false;
let mockRateAllowed = true;
let mockColdCache = false;
const clone = (value: any) => value == null ? value : JSON.parse(JSON.stringify(value));
const snapshot = (path: string) => ({ exists: mockDocuments.has(path), data: () => clone(mockDocuments.get(path)) });
const reference = (path: string): any => ({ path, id: path.split('/').pop(), get: async () => snapshot(path),
  update: async (value: any) => mockDocuments.set(path, { ...mockDocuments.get(path), ...clone(value) }) });
const mockDatabase: any = {
  collection: (name: string) => ({ doc: (id = 'audit') => reference(`${name}/${id}`) }),
  runTransaction: async (fn: any) => {
    const writes: any[] = [];
    const result = await fn({
      get: async (ref: any) => { if (writes.length) throw Error('Firestore read after write'); return snapshot(ref.path); },
      create: (ref: any, value: any) => writes.push(['create', ref.path, clone(value)]),
      update: (ref: any, value: any) => writes.push(['update', ref.path, clone(value)]),
    });
    for (const [kind, path] of writes) {
      if (kind === 'create' && mockDocuments.has(path)) throw Error('already exists');
      if (kind === 'update' && !mockDocuments.has(path)) throw Error('missing document');
    }
    for (const [kind, path, value] of writes) mockDocuments.set(path,
      kind === 'create' ? value : { ...mockDocuments.get(path), ...value });
    return result;
  },
};
jest.mock('firebase-admin', () => ({
  firestore: Object.assign(() => mockDatabase, { FieldValue: { serverTimestamp: () => 'server-time' } }),
  database: () => ({ ref: (path: string) => ({
    get: async () => ({ val: () => clone(mockRealtime.get(path)) }),
    transaction: async (fn: any) => {
      if (path.startsWith(mockFailurePath) && mockFailurePath) { mockFailurePath = ''; throw Error('temporary outage'); }
      // RTDB invokes the callback with null before fetching the server value.
      // Returning undefined at that point aborts without a compare-and-retry.
      const cached = mockColdCache ? null : clone(mockRealtime.get(path));
      let next = fn(cached);
      if (next === undefined) return { committed: false };
      if (mockColdCache && mockRealtime.has(path)) next = fn(clone(mockRealtime.get(path)));
      if (next === undefined) return { committed: false };
      if (next === null) mockRealtime.delete(path); else mockRealtime.set(path, clone(next));
      return { committed: true, snapshot: { val: () => clone(next) } };
    },
  }) }),
  auth: () => ({ getUser: async () => ({ email: 'owner@example.test', disabled: mockDisabled,
    providerData: [{ providerId: mockProvider }] }) }),
}));
jest.mock('../rateLimit', () => ({ checkRateLimit: async () => mockRateAllowed, hashIp: () => 'ip-hash' }));
jest.mock('../tokenMint', () => ({ driverAuthUid: (id: string) => `driver_${id.replace(/-/g, '').slice(0, 28)}`,
  ensureDriverAuthUser: async (id: string) => `driver_${id.replace(/-/g, '').slice(0, 28)}` }));
jest.mock('../operational/ensureEmptyShiftAuthority', () => ({
  ensureInitializedEmptyShiftAuthority: async () => ({ decision: { action: 'create' }, wrote: true }),
  assertEnsureAuthorityOk: () => undefined,
}));

const input = { schemaVersion: 1, companyName: 'Hots Oiler LLC', displayName: 'Owner One', passcode: 'test-password-only' };
const request = (data: any = input, uid = 'owner-one'): any => ({ data, auth: { uid }, rawRequest: { ip: '127.0.0.1' } });
const signup = (data?: any, uid?: string): Promise<any> => createOwnerCompany.run(request(data, uid));
beforeEach(() => { mockDocuments.clear(); mockRealtime.clear(); mockFailurePath = ''; mockProvider = 'password'; mockDisabled = false; mockRateAllowed = true; mockColdCache = false; });

test('creates an isolated owner and company with hashed app credentials and only free entitlements', async () => {
  const result = await signup();
  expect(result.companyId).toBe(ownerCompanyId('owner-one'));
  expect(result.companyName).toBe('Hots Oiler LLC');
  const credential = mockDocuments.get(`driver_credentials/${result.driverId}`);
  expect(credential.active).toBe(true);
  expect(await verifyPasscodeScrypt(input.passcode, credential.passcode)).toBe(true);
  expect(JSON.stringify([...mockDocuments, ...mockRealtime])).not.toContain(input.passcode);
  expect(mockRealtime.get(`drivers/profiles/${result.driverId}`)).toMatchObject({ companyId: result.companyId, active: true, roles: ['driver', 'admin'] });
  for (const uid of ['owner-one', driverAuthUid(result.driverId)]) {
    expect(mockDocuments.get(`trusted_staff_authority/${uid}`)).toMatchObject({ companyId: result.companyId, active: true });
  }
  expect(ownerFreePlan(result.companyId).apps?.['wellbuilt-tickets']?.included).toBe(false);
  expect(ownerFreePlan(result.companyId).apps?.['wellbuilt-mobile']?.included).toBe(false);
  expect(OWNER_CAPABILITIES.every(cap => (TRUSTED_CAPABILITY_ALLOWLIST as readonly string[]).includes(cap))).toBe(true);
  expect(await getOwnerCompanySetup.run(request())).toEqual(result);
  const parsed = parseCompanyContract(mockDocuments.get(`companies/${result.companyId}`).wellbuiltContract);
  if (parsed.state !== 'active') throw Error(JSON.stringify(parsed));
  for (const app of ['wellbuilt-jsa', 'wellbuilt-equipment', 'wellbuilt-dashboard'] as const) {
    expect(decideAppEntitlementAuthorization({ app, contractState: parsed.state, contract: parsed.contract,
      plan: ownerFreePlan(result.companyId), shift: null }).ok).toBe(true);
  }
  for (const app of ['wellbuilt-tickets', 'wellbuilt-mobile'] as const) {
    expect(decideAppEntitlementAuthorization({ app, contractState: parsed.state, contract: parsed.contract,
      plan: ownerFreePlan(result.companyId), shift: null }).ok).toBe(false);
  }
});
test('repeated signup returns the same company, driver and join code', async () => {
  const first = await signup(); const count = mockDocuments.size;
  expect(await signup()).toEqual(first); expect(mockDocuments.size).toBe(count);
});
test('activates with a cold RTDB cache instead of aborting the initial null callback', async () => {
  mockColdCache = true;
  const result = await signup();
  expect(mockRealtime.get(`drivers/profiles/${result.driverId}`).active).toBe(true);
  expect(mockDocuments.get('owner_company_signups/owner-one').state).toBe('complete');
});
test('resumes a ready journal with the same driver after a cold-cache activation retry', async () => {
  mockFailurePath = 'users/'; await expect(signup()).rejects.toThrow();
  const reserved = clone(mockDocuments.get('owner_company_signups/owner-one'));
  mockRealtime.get(`drivers/profiles/${reserved.driverId}`).active = false;
  mockRealtime.get(`drivers/profiles/${reserved.driverId}`).ownerSignupState = 'preparing';
  mockColdCache = true;
  const result = await signup(); expect(result.driverId).toBe(reserved.driverId);
});
test.each(['drivers/profiles/', 'users/'])('resumes the same setup after an outage at %s', async path => {
  mockFailurePath = path; await expect(signup()).rejects.toThrow('temporary outage');
  const reserved = clone(mockDocuments.get('owner_company_signups/owner-one'));
  const result = await signup(); expect(result.driverId).toBe(reserved.driverId); expect(result.companyId).toBe(reserved.companyId);
});
test.each([{ companyId: 'liquid-gold', role: 'admin' }, { role: 'it' }])('preserves an existing account binding %j', async prior => {
  mockRealtime.set('users/owner-one', prior);
  await expect(signup()).rejects.toThrow('already belongs');
  expect(mockRealtime.get('users/owner-one')).toEqual(prior); expect(mockDocuments.size).toBe(0);
});
test.each(['trusted_staff_authority/owner-one', 'platform_admins/owner-one', 'driver_name_index/owner one'])('does not adopt existing authority or identity at %s', async path => {
  mockDocuments.set(path, { existing: true });
  await expect(signup()).rejects.toThrow('already belongs'); expect(mockDocuments.size).toBe(1);
});
test('cannot claim another owner’s app sign-in name', async () => {
  await signup(); await expect(signup(input, 'second-owner')).rejects.toThrow('already belongs');
  expect(mockDocuments.has(`companies/${ownerCompanyId('second-owner')}`)).toBe(false);
});
test.each(['companyName', 'displayName', 'passcode'])('retry cannot change reserved %s', async field => {
  mockFailurePath = 'drivers/profiles/'; await expect(signup()).rejects.toThrow();
  await expect(signup({ ...input, [field]: 'Something Different' })).rejects.toThrow('already belongs');
});
test.each(['company', 'credential', 'profile', 'authority'])('retry cannot reactivate revoked %s', async kind => {
  const result = await signup();
  if (kind === 'company') mockDocuments.get(`companies/${result.companyId}`).status = 'archived';
  if (kind === 'credential') mockDocuments.get(`driver_credentials/${result.driverId}`).active = false;
  if (kind === 'profile') mockRealtime.get(`drivers/profiles/${result.driverId}`).active = false;
  if (kind === 'authority') mockDocuments.get('trusted_staff_authority/owner-one').active = false;
  await expect(signup()).rejects.toThrow();
});
test('does not activate an archived company after an interrupted reservation', async () => {
  mockFailurePath = 'drivers/profiles/'; await expect(signup()).rejects.toThrow();
  mockDocuments.get(`companies/${ownerCompanyId('owner-one')}`).status = 'archived';
  await expect(signup()).rejects.toThrow('already belongs');
  expect(mockDocuments.get(`companies/${ownerCompanyId('owner-one')}`).status).toBe('archived');
});
test.each(['companyId', 'roles', 'capabilities', 'planId'])('rejects client-controlled privilege field %s', field => {
  expect(() => ownerSignupInput({ ...input, [field]: 'admin' })).toThrow('Invalid company signup');
});
test('requires authentication, password account, active Auth user and rate allowance', async () => {
  await expect(createOwnerCompany.run({ ...request(), auth: undefined })).rejects.toThrow('Create or sign in');
  mockProvider = 'anonymous'; await expect(signup()).rejects.toThrow('email/password'); mockProvider = 'password';
  mockDisabled = true; await expect(signup()).rejects.toThrow('email/password'); mockDisabled = false;
  mockRateAllowed = false; await expect(signup()).rejects.toThrow('Please wait'); expect(mockDocuments.size).toBe(0);
});
