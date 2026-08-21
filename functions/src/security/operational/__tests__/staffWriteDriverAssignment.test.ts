import {
  assertCanonicalDriverId,
  evaluateStaffWriteDriverAssignment,
} from '../staffWriteDriverAssignment';

const DRIVER_ID = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const OTHER_ID = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';

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

  it('refuses missing, inactive, and unscoped profiles (legacy-only rows)', () => {
    const base = {
      driverId: DRIVER_ID,
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
      mirrorLegacy: false,
      approvedRows: [] as Array<{ key: string; migratedToDriverId?: unknown; displayName?: unknown }>,
    };
    expect(evaluateStaffWriteDriverAssignment({ ...base, profile: null }))
      .toEqual({ ok: false, reason: 'profile_missing' });
    expect(evaluateStaffWriteDriverAssignment({ ...base, profile: { ...liveProfile, active: false } }))
      .toEqual({ ok: false, reason: 'profile_inactive' });
    expect(evaluateStaffWriteDriverAssignment({ ...base, profile: { ...liveProfile, companyId: '' } }))
      .toEqual({ ok: false, reason: 'profile_unscoped' });
  });

  it('enforces tenant isolation', () => {
    expect(evaluateStaffWriteDriverAssignment({
      driverId: DRIVER_ID,
      profile: liveProfile,
      callerCompanyId: 'other-co',
      isPlatformAdmin: false,
      mirrorLegacy: false,
      approvedRows: [],
    })).toEqual({ ok: false, reason: 'tenant_mismatch' });
  });

  it('does not join identities by display name', () => {
    const decided = evaluateStaffWriteDriverAssignment({
      driverId: DRIVER_ID,
      profile: liveProfile,
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
      mirrorLegacy: false,
      approvedRows: [
        { key: 'da561bc41eaaaaaaaa', displayName: 'Mikezfold' },
        { key: 'fd5e1e99da0dbbbbbb', displayName: 'Mikezfold' },
      ],
    });
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(decided.mirrorLegacyKey).toBeNull();
  });

  it('refuses ambiguous legacy links and unproven mirroring', () => {
    const twoLinks = [
      { key: 'aaaaaaaaaaaaaaaa', migratedToDriverId: DRIVER_ID, displayName: 'A' },
      { key: 'bbbbbbbbbbbbbbbb', migratedToDriverId: DRIVER_ID, displayName: 'B' },
    ];
    expect(evaluateStaffWriteDriverAssignment({
      driverId: DRIVER_ID,
      profile: liveProfile,
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
      mirrorLegacy: false,
      approvedRows: twoLinks,
    })).toEqual({ ok: false, reason: 'ambiguous_legacy_link' });

    expect(evaluateStaffWriteDriverAssignment({
      driverId: DRIVER_ID,
      profile: liveProfile,
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
      mirrorLegacy: true,
      approvedRows: [{ key: 'cccccccccccccccc', displayName: 'Mikezfold' }],
    })).toEqual({ ok: false, reason: 'legacy_link_unproven' });
  });

  it('mirrors only the exactly linked approved row', () => {
    const decided = evaluateStaffWriteDriverAssignment({
      driverId: DRIVER_ID,
      profile: liveProfile,
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
      mirrorLegacy: true,
      approvedRows: [
        { key: 'fd5e1e99da0dcccccc', migratedToDriverId: DRIVER_ID, displayName: 'Mikezfold' },
        { key: 'da561bc41eeeeeeeee', migratedToDriverId: OTHER_ID, displayName: 'MikeS24' },
      ],
    });
    expect(decided).toMatchObject({ ok: true, mirrorLegacyKey: 'fd5e1e99da0dcccccc' });
  });

  it('concurrency-protects against stale assignedRoutes', () => {
    expect(evaluateStaffWriteDriverAssignment({
      driverId: DRIVER_ID,
      profile: { ...liveProfile, assignedRoutes: ['Gabriels'] },
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
      mirrorLegacy: false,
      approvedRows: [],
      expectedAssignedRoutes: null,
    })).toEqual({ ok: false, reason: 'concurrency_conflict' });
  });
});
