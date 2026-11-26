const mockTree: any = {};
function mockGet(p: string) { return p.split('/').filter(Boolean).reduce((o, k) => o?.[k], mockTree) ?? null; }
function mockSet(p: string, v: any) { const parts = p.split('/').filter(Boolean), k = parts.pop()!;
  const parent = parts.reduce((o, k) => o[k] ||= {}, mockTree); if (v === null) delete parent[k]; else parent[k] = JSON.parse(JSON.stringify(v)); }
class MockRef {
  filter?: string; value?: any;
  constructor(public path: string) {}
  orderByChild(field: string) { this.filter = field; return this; }
  equalTo(value: any) { this.value = value; return this; }
  limitToFirst() { return this; }
  async once() { let v = mockGet(this.path); if (this.filter && v) v = Object.fromEntries(Object.entries(v).filter(([, row]: any) => row[this.filter!] === this.value));
    return { val: () => v, exists: () => v !== null }; }
  async update(patch: any) { for (const [k, v] of Object.entries(patch)) mockSet([this.path, k].filter(Boolean).join('/'), v); }
  async transaction(update: any) {
    // A cold SDK cache first supplies null. Undefined aborts locally; a proposal
    // makes it to server CAS, which retries against the actual stored value.
    if (this.path.startsWith('wellOperatingLocks/') && update(null) === undefined)
      return { committed: false, snapshot: { val: () => mockGet(this.path) } };
    const v = update(mockGet(this.path)); if (v !== undefined) mockSet(this.path, v);
    return { committed: v !== undefined, snapshot: { val: () => mockGet(this.path) } }; }
}
jest.mock('firebase-admin', () => ({ database: () => ({ ref: (p = '') => new MockRef(p) }) }));
jest.mock('../../requireDriverAuth', () => ({ requireSecureDriver: async (r: any) => {
  if (!r.auth) throw Error('unauthenticated'); return { companyId: r.auth.companyId || 'liquid-gold', driverId: r.auth.uid, displayName: r.auth.uid };
} }));
jest.mock('../../trustedStaffAuthority', () => ({ requireTrustedCompanyCapability: async (uid: string, capability: string) => {
  if (uid !== 'office' && !(uid === 'admin' && capability === 'manageCompany')) throw Error('denied'); return { uid, companyId: 'liquid-gold' };
} }));
import { driverWellOperatingStatusHandler as driver, reviewWellOperatingStatusHandler as staff } from '../wellOperatingStatus';
const req = (action: string, extra: any = {}, uid = 'driver') => ({ auth: { uid, token: {} }, data: { action, wellConfigKey: 'Test Well', ...extra } });
const intent = { operationId: 'wos_test123456', expectedDown: false, down: true };
beforeEach(() => { for (const k of Object.keys(mockTree)) delete mockTree[k];
  mockSet('well_config/Test Well', { companyId: 'liquid-gold', route: 'Test Route', isDown: false });
  mockSet('wells/Test Well/status', { isDown: false, lastPull: { packetId: 'existing-pickup', bblsTaken: 140 } });
  mockSet('drivers/profiles/driver', { companyId: 'liquid-gold', active: true, assignedRoutes: ['Test Route'], primaryRoutes: ['Test Route'] });
  mockSet('packets/outgoing/test', { wellName: 'Test Well', wellDown: false, lastPullPacketId: 'existing-pickup', lastPullBbls: '140' });
});
test('authorized change updates flags and audit once without a zero-BBL packet or changed job', async () => {
  expect((await driver(req('status'))).canChange).toBe(true);
  await driver(req('set', intent)); const snapshot = JSON.stringify(mockTree);
  await driver(req('set', intent)); expect(JSON.stringify(mockTree)).toBe(snapshot);
  expect(mockGet('wells/Test Well/status/isDown')).toBe(true);
  expect(mockGet('well_config/Test Well/isDown')).toBe(true);
  expect(mockGet('packets/outgoing/test/lastPullBbls')).toBe('140');
  expect(mockGet('packets/incoming')).toBeNull(); expect(mockGet('invoices')).toBeNull();
  expect(mockGet('wellOperatingLocks/liquid-gold/Test Well')).toBeNull();
});
test('unassigned driver requests approval; staff approval applies without changing pickup evidence', async () => {
  mockSet('drivers/profiles/driver/assignedRoutes', []);
  expect((await driver(req('status'))).canChange).toBe(false);
  await expect(driver(req('set', intent))).rejects.toThrow('approval');
  await driver(req('request', intent)); expect(mockGet('wells/Test Well/status/isDown')).toBe(false);
  await expect(staff({ auth: { uid: 'office', token: { kind: 'driver' } }, data: { action: 'approve', id: intent.operationId } })).rejects.toThrow('staff session');
  await staff({ auth: { uid: 'office', token: {} }, data: { action: 'approve', id: intent.operationId } });
  expect(mockGet('wellOperatingRequests/liquid-gold/' + intent.operationId + '/status')).toBe('approved');
  expect(mockGet('wells/Test Well/status/isDown')).toBe(true);
  expect(mockGet('wells/Test Well/status/lastPull/packetId')).toBe('existing-pickup');
});
test('wrong company, stale state and reused operation identity fail closed', async () => {
  await expect(driver({ ...req('set', intent), auth: { uid: 'driver', companyId: 'other' } })).rejects.toThrow('company');
  mockSet('wells/Test Well/status/isDown', true);
  await expect(driver(req('set', intent))).rejects.toThrow('status changed');
  mockSet('wells/Test Well/status/isDown', false); await driver(req('set', intent));
  await expect(driver(req('set', { ...intent, expectedDown: true, down: false }))).rejects.toThrow('original request');
});
test('company administration can approve even without dispatch permission', async () => {
  mockSet('drivers/profiles/driver/assignedRoutes', []);
  await driver(req('request', intent));
  await staff({ auth: { uid: 'admin', token: {} }, data: { action: 'approve', id: intent.operationId } });
  expect(mockGet('wells/Test Well/status/isDown')).toBe(true);
});
test('an old company token cannot read or request changes after the profile moves company', async () => {
  mockSet('drivers/profiles/driver/companyId', 'other');
  await expect(driver(req('status'))).rejects.toThrow('company changed');
  await expect(driver(req('request', intent))).rejects.toThrow('company changed');
  expect(mockGet('wellOperatingRequests')).toBeNull();
});
test('explicit Up after Down restores the recorded level and leaves pickup identity untouched', async () => {
  await driver(req('set', intent));
  mockSet('packets/outgoing/test/currentLevel', 'Down');
  mockSet('packets/outgoing/test/lastPullBottomLevel', '4\'2"');
  await driver(req('set', { operationId: 'wos_up_test123456', expectedDown: true, down: false }));
  expect(mockGet('wells/Test Well/status/isDown')).toBe(false);
  expect(mockGet('packets/outgoing/test/wellDown')).toBe(false);
  expect(mockGet('packets/outgoing/test/currentLevel')).toBe('4\'2"');
  expect(mockGet('packets/outgoing/test/lastPullPacketId')).toBe('existing-pickup');
  expect(mockGet('packets/incoming')).toBeNull();
  expect(Object.keys(mockGet('wellOperatingOperations/liquid-gold'))).toHaveLength(2);
});
test('Depart intent requires current route ownership; revocation never auto-creates a report', async () => {
  mockSet('drivers/profiles/driver/assignedRoutes', []);
  await expect(driver(req('saveOnDepart', intent))).rejects.toThrow('requires ownership');
  expect(mockGet('wells/Test Well/status/isDown')).toBe(false);
  expect(mockGet('wellOperatingOperations')).toBeNull();
  expect(mockGet('wellOperatingRequests')).toBeNull();
});
test('Depart applies an authorized checkbox; unchanged actual status creates no operation', async () => {
  const result = await driver(req('saveOnDepart', intent));
  expect(result.status).toBe('applied');
  expect(mockGet('wells/Test Well/status/isDown')).toBe(true);
  const replay = await driver(req('saveOnDepart', intent));
  expect(replay.unchanged).toBe(true);
  expect(Object.keys(mockGet('wellOperatingOperations/liquid-gold'))).toHaveLength(1);
});


test('route access helper is read-only until company explicitly grants primary access', async () => {
  mockSet('drivers/profiles/driver/primaryRoutes', []);
  expect((await driver(req('status'))).canChange).toBe(false);
  await expect(driver(req('saveOnDepart', intent))).rejects.toThrow('requires ownership');
  expect(mockGet('wellOperatingOperations')).toBeNull();
  await driver(req('request', intent));
  expect(mockGet('wellOperatingRequests/liquid-gold/'+intent.operationId+'/status')).toBe('pending');
  expect(mockGet('wells/Test Well/status/isDown')).toBe(false);
});

test('two explicitly granted owners may independently manage the same route', async () => {
  mockSet('drivers/profiles/second', {companyId:'liquid-gold',active:true,assignedRoutes:['Test Route'],primaryRoutes:['Test Route']});
  expect((await driver(req('status'))).canChange).toBe(true);
  expect((await driver(req('status',{},'second'))).canChange).toBe(true);
  await driver(req('saveOnDepart',intent));
  await driver(req('saveOnDepart',{operationId:'wos_second_up123',expectedDown:true,down:false},'second'));
  expect(mockGet('wells/Test Well/status/isDown')).toBe(false);
  expect(mockGet('wells/Test Well/status/lastPull/packetId')).toBe('existing-pickup');
});
