import { evaluateBootstrapDriverSession } from '../sessionBootstrap';
import { driverAuthUid } from '../tokenMint';

describe('bootstrapDriverSession', () => {
  const driverId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const uid = driverAuthUid(driverId);

  it('returns authoritative roles and iPhone16 admin metadata', async () => {
    const r = await evaluateBootstrapDriverSession({
      uid,
      claims: { kind: 'driver', driverId, companyId: 'liquid-gold', roles: ['driver'] },
      data: {},
      loadProfile: async () => ({
        displayName: 'iPhone16',
        legalName: 'iPhone16',
        companyId: 'liquid-gold',
        companyName: 'Liquid Gold',
        isAdmin: true,
        isViewer: false,
        roles: ['admin'],
        assignedRoutes: ['a', 'b', 'c'],
        assignedCustomers: ['x'],
        active: true,
      }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.isAdmin).toBe(true);
      expect(r.value.roles).toEqual(['admin']);
      expect(r.value.assignedRoutes).toEqual(['a', 'b', 'c']);
      expect(r.value.companyId).toBe('liquid-gold');
    }
  });

  it('rejects empty body extras and unauthenticated callers', async () => {
    const bad = await evaluateBootstrapDriverSession({
      uid,
      claims: { kind: 'driver', driverId, companyId: 'liquid-gold' },
      data: { spoof: true },
      loadProfile: async () => ({}),
    });
    expect(bad.ok).toBe(false);
    const unauth = await evaluateBootstrapDriverSession({
      uid: null,
      claims: {},
      data: {},
      loadProfile: async () => ({}),
    });
    expect(unauth.ok).toBe(false);
  });
});
