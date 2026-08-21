/**
 * In-memory integration: Dashboard assignment → canonical profile →
 * bootstrap → scoped well config → WB-M-equivalent eligibility.
 */
import { evaluateAssignDriverAssignment } from '../assignDriverAssignment';
import { evaluateCanonicalAssignment, selectAssignedWellConfig } from '../canonicalAssignment';
import { evaluateBootstrapDriverSession } from '../../sessionBootstrap';
import { driverAuthUid } from '../../tokenMint';

const DRIVER_ID = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const LEGACY_KEY = 'd'.repeat(64);

const catalog = {
  Gab1: { companyId: 'liquid-gold', route: 'Gabriels' },
  Other: { companyId: 'liquid-gold', route: 'Montana' },
};

function applyPatch(
  profile: Record<string, unknown>,
  legacy: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('/');
    if (parts[0] === 'drivers' && parts[1] === 'profiles' && parts[2] === DRIVER_ID) {
      profile[parts[3]] = value;
    }
    if (parts[0] === 'drivers' && parts[1] === 'approved' && parts[2] === LEGACY_KEY) {
      legacy[parts[3]] = value;
    }
  }
}

describe('assignment pipeline', () => {
  it('Dashboard write reaches canonical profile, bootstrap, scoped wells, and eligible verdict', async () => {
    const profile: Record<string, unknown> = {
      displayName: 'Mikezfold',
      companyId: 'liquid-gold',
      companyName: 'Liquid Gold Trucking LLC',
      active: true,
      roles: ['driver'],
    };
    const legacy: Record<string, unknown> = {
      displayName: 'Mikezfold',
      companyId: 'liquid-gold',
      active: true,
    };

    const assigned = evaluateAssignDriverAssignment({
      callerUid: 'admin',
      isPlatformAdmin: true,
      driverId: DRIVER_ID,
      legacyKey: LEGACY_KEY,
      assignedRoutes: ['Gabriels'],
      profile: {
        exists: true,
        driverId: DRIVER_ID,
        active: true,
        companyId: 'liquid-gold',
        displayName: 'Mikezfold',
      },
      legacyRow: {
        exists: true,
        key: LEGACY_KEY,
        active: true,
        companyId: 'liquid-gold',
        displayName: 'Mikezfold',
      },
      now: 42,
    });
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) return;
    applyPatch(profile, legacy, assigned.patch);

    expect(profile.assignedRoutes).toEqual(['Gabriels']);
    expect(legacy.assignedRoutes).toEqual(['Gabriels']);

    const boot = await evaluateBootstrapDriverSession({
      uid: driverAuthUid(DRIVER_ID),
      claims: { kind: 'driver', driverId: DRIVER_ID, companyId: 'liquid-gold', roles: ['driver'] },
      data: {},
      loadProfile: async () => profile,
    });
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;
    expect(boot.value.assignedRoutes).toEqual(['Gabriels']);

    const wells = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
      assignedRoutes: boot.value.assignedRoutes,
      assignedWells: boot.value.assignedWells,
    });
    expect(wells.status).toBe('scoped');
    expect(Object.keys(wells.wells)).toEqual(['Gab1']);

    const eligibility = evaluateCanonicalAssignment({
      assignedRoutes: boot.value.assignedRoutes,
      assignedWells: boot.value.assignedWells,
    });
    expect(eligibility.status).toBe('eligible');
  });

  it('missing canonical assignment stays unknown through bootstrap and well config', async () => {
    const profile: Record<string, unknown> = {
      displayName: 'MikeS24',
      companyId: 'liquid-gold',
      active: true,
      roles: ['driver'],
    };
    const boot = await evaluateBootstrapDriverSession({
      uid: driverAuthUid(DRIVER_ID),
      claims: { kind: 'driver', driverId: DRIVER_ID, companyId: 'liquid-gold' },
      data: {},
      loadProfile: async () => profile,
    });
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;
    expect(boot.value.assignedRoutes).toBeNull();
    expect(boot.value.assignedWells).toBeNull();
    const wells = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
      assignedRoutes: boot.value.assignedRoutes,
      assignedWells: boot.value.assignedWells,
    });
    expect(wells.status).toBe('assignment_unavailable');
    expect(wells.wells).toEqual({});
    expect(evaluateCanonicalAssignment({
      assignedRoutes: boot.value.assignedRoutes,
      assignedWells: boot.value.assignedWells,
    }).status).toBe('unknown');
  });
});
