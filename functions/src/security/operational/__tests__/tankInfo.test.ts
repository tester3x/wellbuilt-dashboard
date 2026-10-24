import { tankInfoAuthority, tankInfoPatch, tankInfoProjection } from '../tankInfoModel';
import { primaryRouteUpdate } from '../primaryRouteModel';
const well = { route: 'Route A', companyId: 'company-a', numTanks: 4, activeTanks: 4,
  totalTanks: 4, tankHeight: 30.25, tankDiameter: 15.5, bblPerFoot: 134.4, tankCapacity: 1000,
  ndicName: 'Example 1', ndicApiNo: '00-000-00000-00-00' };
const driver = { companyId: 'company-a', active: true, assignedRoutes: ['Route A', 'Route B'], primaryRoutes: ['Route A'] };
test('primary designation grants editing only on that route; fill-in assignments grant viewing only', () => {
  expect(tankInfoAuthority(driver, well, 'driver-a', 'company-a')).toMatchObject({ canView: true, canEdit: true });
  expect(tankInfoAuthority(driver, { ...well, route: 'Route B' }, 'driver-a', 'company-a'))
    .toMatchObject({ canView: true, canEdit: false });
  expect(tankInfoAuthority({ ...driver, primaryRoutes: [] }, well, 'fill-in', 'company-a').canEdit).toBe(false);
});
test('global primary and company admin can edit, but not across companies or as viewer', () => {
  expect(tankInfoAuthority({ ...driver, primaryAllRoutes: true }, { ...well, route: 'Future route' }, 'driver-a', 'company-a').canEdit).toBe(true);
  expect(tankInfoAuthority({ ...driver, isAdmin: true }, well, 'admin', 'company-a').canEdit).toBe(true);
  expect(tankInfoAuthority({ ...driver, isAdmin: true }, well, 'admin', 'other-company').canEdit).toBe(false);
  expect(tankInfoAuthority({ ...driver, isViewer: true }, well, 'viewer', 'company-a').canEdit).toBe(false);
});
test('explicit well viewing permits do not create edit authority', () => {
  expect(tankInfoAuthority({ assignedRoutes: [], assignedWells: ['Example 1'] },
    { ...well, wellName: 'Example 1' }, 'fill-in', 'company-a')).toMatchObject({ canView: true, canEdit: false });
});
test('connected tanks update every operational count and the combined calibration', () => {
  expect(tankInfoPatch(well, { activeTanks: 2 })).toEqual({ activeTanks: 2, numTanks: 2, tanks: 2,
    perTankBblPerFoot: 33.6, bblPerFoot: 67.2 });
  expect(tankInfoPatch(well, { tankDiameter: 15.5 })).toMatchObject({ perTankBblPerFoot: 33.6, bblPerFoot: 134.4 });
  expect(tankInfoPatch(well, { perTankBblPerFoot: 34 })).toMatchObject({ bblPerFoot: 136 });
});
test.each(['ndicName', 'ndicApiNo', 'operator', 'route', 'companyId', 'primaryRoutes', 'primaryAllRoutes', 'isAdmin', 'bblPerFoot', 'tankInfoRevision'])(
  'rejects immutable identity/authority field %s even for an editor', key => {
    expect(() => tankInfoPatch(well, { [key]: 'spoofed' })).toThrow('invalid_field');
  });
test.each([{ activeTanks: 5 }, { activeTanks: 1.5 }, { tankHeight: 0 }, { tankDiameter: NaN },
  { h2sStatus: 'safe' }, { tankNotes: 'x'.repeat(1001) }, { allowedBottom: 31 }])('rejects inconsistent or invalid tank setup %j', patch => {
  expect(() => tankInfoPatch(well, patch)).toThrow();
});
test('read-only identifiers are displayed but receipt/audit and other raw fields are not exposed', () => {
  const projection = tankInfoProjection({ ...well, tankInfoEdits: { secret: {} }, internal: 'hidden' });
  expect(projection.ndicApiNo).toBe(well.ndicApiNo);
  expect(projection.tankInfoEdits).toBeUndefined(); expect(projection.internal).toBeUndefined();
});
test('primary administration preserves viewing, credentials, roles, and other fields', () => {
  const original = { ...driver, primaryRouteRevision: 3, signature: 'preserved' };
  const updated = primaryRouteUpdate(original, 'company-a', { primaryRoutes: ['Route B'], primaryAllRoutes: false, expectedRevision: 3 }, 'staff', 100);
  expect(updated.assignedRoutes).toEqual(original.assignedRoutes);
  expect(updated.signature).toBe(original.signature);
  expect(updated.primaryRoutes).toEqual(['Route B']); expect(updated.primaryRouteRevision).toBe(4);
  expect(updated.primaryRouteAudit['4'].before.primaryRoutes).toEqual(['Route A']);
  expect(original.primaryRoutes).toEqual(['Route A']);
});
test('primary assignments use revision checks and safely acknowledge an exact retry', () => {
  const request = { primaryRoutes: ['Route A'], primaryAllRoutes: false, expectedRevision: 0 };
  const updated = primaryRouteUpdate(driver, 'company-a', request, 'staff', 100);
  expect(primaryRouteUpdate(updated, 'company-a', request, 'staff', 101)).toBe(updated);
  expect(() => primaryRouteUpdate(updated, 'company-a', { ...request, primaryRoutes: ['Route B'] }, 'staff', 102)).toThrow('primary_routes_changed');
  expect(() => primaryRouteUpdate(driver, 'company-a', { ...request, primaryRoutes: ['Unassigned'] }, 'staff', 100)).toThrow('primary_route_not_assigned');
  expect(() => primaryRouteUpdate(driver, 'other-company', request, 'staff', 100)).toThrow('driver_unavailable');
});
