import {
  assertCanonicalDriverId,
  evaluateStaffWriteDriverAssignment,
} from '../staffWriteDriverAssignment';

const DRIVER_ID = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const liveProfile = {
  displayName: 'Mikezfold',
  active: true,
  companyId: 'liquid-gold',
  assignedRoutes: null,
};

describe('staffWriteDriverAssignment identity rules', () => {
  it('requires an exact canonical UUID driverId', () => {
    expect(() => assertCanonicalDriverId('fd5e1e99da0d')).toThrow('driver_id_malformed');
    expect(() => assertCanonicalDriverId('Mikezfold')).toThrow('driver_id_malformed');
    expect(assertCanonicalDriverId(DRIVER_ID)).toBe(DRIVER_ID);
  });

  it('refuses missing, inactive, unscoped, and tenant-mismatched profiles', () => {
    const base = {
      driverId: DRIVER_ID,
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    };
    expect(evaluateStaffWriteDriverAssignment({ ...base, profile: null }))
      .toEqual({ ok: false, reason: 'profile_missing' });
    expect(evaluateStaffWriteDriverAssignment({ ...base, profile: { ...liveProfile, active: false } }))
      .toEqual({ ok: false, reason: 'profile_inactive' });
    expect(evaluateStaffWriteDriverAssignment({ ...base, profile: { ...liveProfile, companyId: '' } }))
      .toEqual({ ok: false, reason: 'profile_unscoped' });
    expect(evaluateStaffWriteDriverAssignment({
      ...base,
      profile: liveProfile,
      callerCompanyId: 'other-co',
    })).toEqual({ ok: false, reason: 'tenant_mismatch' });
  });

  it('does not consult display names or legacy approved rows', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../staffWriteDriverAssignment.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/displayName/);
    expect(src).not.toMatch(/drivers\/approved/);
    expect(src).not.toMatch(/mirrorLegacy/);
  });
});

describe('staffWriteDriverAssignment trusted authority', () => {
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const callable = readFileSync(join(__dirname, '../../staffWriteDriverAssignmentCallable.ts'), 'utf8');

  it('uses trusted manageDrivers and hard-false platform admin', () => {
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).toMatch(/staffWriteDispatchAccessFromTrusted/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/adminAuth/);
    expect(callable).toMatch(/callerCompanyId: access\.companyId/);
    expect(callable).toMatch(/isPlatformAdmin: access\.isPlatformAdmin/);
    expect(callable).toMatch(/callerUid: access\.uid/);
  });
});
