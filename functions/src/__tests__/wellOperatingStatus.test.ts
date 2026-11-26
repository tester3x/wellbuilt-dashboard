import { canManageWellStatus, statusIntent } from '../security/operational/wellOperatingPolicy';
const profile = { companyId: 'liquid-gold', active: true, assignedRoutes: ['Gabriels'], assignedWells: [] };
const config = { route: 'Gabriels', companyId: 'liquid-gold' };
test('WB M route access enables direct change; roles and client flags cannot grant it', () => {
  expect(canManageWellStatus(profile, 'liquid-gold', 'Well', config)).toBe(true);
  expect(canManageWellStatus({ ...profile, assignedRoutes: [], roles: ['admin'], canChange: true }, 'liquid-gold', 'Well', config)).toBe(false);
  expect(canManageWellStatus({ ...profile, assignedRoutes: ['Other'] }, 'liquid-gold', 'Well', config)).toBe(false);
});
test('individual WB M visibility is not route ownership; missing ownership fails closed', () => {
  expect(canManageWellStatus({ ...profile, assignedRoutes: [], assignedWells: ['Well'] }, 'liquid-gold', 'Well', config)).toBe(false);
  for (const p of [{ companyId: 'liquid-gold' }, { ...profile, assignedRoutes: [], assignedWells: [] }, { ...profile, active: false }])
    expect(canManageWellStatus(p, 'liquid-gold', 'Well', config)).toBe(false);
});
test('route assignment never grants access to another company', () => {
  expect(canManageWellStatus(profile, 'other', 'Well', config)).toBe(false);
  expect(canManageWellStatus(profile, 'liquid-gold', 'Well', { ...config, companyId: 'other' })).toBe(false);
});
test('intent is explicit, boolean, scoped and stable, never inferred from a pickup', () => {
  const input = { operationId: 'wos_test123456', wellConfigKey: 'Well', expectedDown: false, down: true };
  expect(statusIntent(input)).toEqual(input);
  for (const value of [{ ...input, down: 'true' }, { ...input, down: false }, { ...input, wellConfigKey: '../Other' }, { ...input, operationId: '' }])
    expect(() => statusIntent(value)).toThrow();
});
