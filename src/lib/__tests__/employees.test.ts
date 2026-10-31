import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEmployees, EmployeeDriverInput, EmployeeUserInput } from '../employees';

const driver: EmployeeDriverInput = {
  key: 'canonical-id', displayName: 'App Nickname', legalName: 'Employee Name',
  companyId: 'company-a', active: true,
};
const user: EmployeeUserInput = {
  uid: 'auth-uid', displayName: 'App Nickname', email: 'employee@example.test',
  role: 'admin', roles: ['admin', 'dispatch'], companyId: 'company-a',
  driverId: 'canonical-id',
};

test('canonical employee identity combines app and dashboard access without changing records', () => {
  const rows = mergeEmployees([driver], [user]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Employee Name');
  assert.equal(rows[0].email, user.email);
  assert.equal(rows[0].mobileLoginActive, true);
  assert.equal(rows[0].hasDashboardLogin, true);
  assert.deepEqual(rows[0].dashboardRoles, ['admin', 'dispatch']);
  assert.equal(rows[0].driver, driver);
  assert.equal(rows[0].dashUser, user);
  assert.equal(driver.dashboardUid, undefined);
});

test('one-sided UID, legacy hash and migrated canonical ID links remain supported', () => {
  for (const [d, u] of [
    [{ ...driver, dashboardUid: user.uid }, { ...user, driverId: undefined }],
    [driver, { ...user, driverId: undefined, driverHash: driver.key }],
    [{ ...driver, key: 'legacy-hash', driverId: driver.key }, user],
  ] as [EmployeeDriverInput, EmployeeUserInput][]) {
    assert.equal(mergeEmployees([d], [u]).length, 1);
  }
});

test('matching names and emails alone never merge employees', () => {
  assert.equal(mergeEmployees([driver], [{ ...user, driverId: undefined }]).length, 2);
});

test('explicit links cannot merge conflicting companies', () => {
  const other = { ...user, companyId: 'company-b', driverHash: driver.key };
  assert.equal(mergeEmployees([{ ...driver, dashboardUid: user.uid }], [other]).length, 2);
});

test('ambiguous canonical links leave accounts separate', () => {
  assert.equal(mergeEmployees([driver], [user, { ...user, uid: 'another-uid' }]).length, 3);
});

test('unlinked employees and inactive mobile login remain visible', () => {
  const rows = mergeEmployees([{ ...driver, active: false }], [{ ...user, driverId: undefined }]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.driver)?.mobileLoginActive, false);
  assert.equal(rows.find(r => !r.driver)?.hasDashboardLogin, true);
});
