import { projectDashboardCatalog } from '../dashboardCatalogProjection';

const profiles = {
  fresh: { displayName: 'New driver', companyId: 'liquid-gold', active: true,
    assignedRoutes: ['North'], assignedWells: ['Well A'], assignmentRevision: 3,
    passcodeHash: 'not-for-client', sessionToken: 'not-for-client' },
  other: { displayName: 'Other company', companyId: 'other' },
  unbound: { displayName: 'Unbound' },
};
const input = { approved: {}, users: {}, wellConfig: {}, profiles };

test('new canonical profiles appear without a legacy approved row, with route scope', () => {
  const out = projectDashboardCatalog({ ...input, caller: { companyId: 'liquid-gold', isPlatformAdmin: false } });
  expect(Object.keys(out.profiles)).toEqual(['fresh']);
  expect(out.counts.profiles).toBe(1);
  expect(out.profiles.fresh).toEqual({ displayName: 'New driver', companyId: 'liquid-gold', active: true,
    assignedRoutes: ['North'], assignedWells: ['Well A'], assignmentRevision: 3 });
});

test('platform catalog includes all profiles but strips credentials', () => {
  const out = projectDashboardCatalog({ ...input, caller: { isPlatformAdmin: true } });
  expect(out.counts.profiles).toBe(3);
  expect(JSON.stringify(out)).not.toContain('not-for-client');
});

test('unbound non-platform caller does not receive unbound profiles', () => {
  const out = projectDashboardCatalog({ ...input, caller: { isPlatformAdmin: false } });
  expect(out.profiles).toEqual({});
});

test('canonical management includes safe driver details, not nested credentials', () => {
  const out = projectDashboardCatalog({ ...input, profiles: { fresh: {
    ...profiles.fresh, truckNumber: '12', trailerNumber: '34', suspendedReason: 'test',
    assignedCustomers: [{ name: 'Customer', companyId: 'customer' }],
    profile: { phone: '555', legalName: 'Driver Name', truckNumber: '12', passcode: 'SECRET' },
  } }, caller: { isPlatformAdmin: true } });
  expect(out.profiles.fresh).toMatchObject({ truckNumber: '12', trailerNumber: '34',
    suspendedReason: 'test', profile: { phone: '555', legalName: 'Driver Name', truckNumber: '12' } });
  expect(JSON.stringify(out)).not.toContain('SECRET');
});

test('canonical dashboard links survive the catalog without using legacy rows', () => {
  const out = projectDashboardCatalog({ ...input,
    profiles: { fresh: { ...profiles.fresh, dashboardUid: 'web-user', dashboardEmail: 'test@example.com' } },
    users: { 'web-user': { companyId: 'liquid-gold', driverId: 'fresh', email: 'test@example.com', roles: ['admin'], role: 'admin', password: 'NEVER_RETURN' } },
    caller: { isPlatformAdmin: true },
  });
  expect(out.profiles.fresh).toMatchObject({ dashboardUid: 'web-user', dashboardEmail: 'test@example.com' });
  expect(out.users['web-user']).toMatchObject({ driverId: 'fresh', roles: ['admin'] });
  expect(JSON.stringify(out)).not.toContain('NEVER_RETURN');
});
