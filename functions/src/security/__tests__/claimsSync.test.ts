import { decideClaimsSync } from '../claimsSync';

describe('claims sync / backfill', () => {
  it('is dual-gated to platform and separates dry-run from execute', () => {
    expect(decideClaimsSync({
      callerIsPlatform: false,
      mode: 'dry_run',
      target: { uid: 'u1' },
      snapshot: { staffEnabled: true, staffCompanyId: 'c1', staffRole: 'manager' },
    })).toMatchObject({ ok: false, reason: 'platform_admin_required' });

    const dry = decideClaimsSync({
      callerIsPlatform: true,
      mode: 'dry_run',
      target: { uid: 'u1', expectedCompanyId: 'c1', expectedRole: 'manager' },
      snapshot: {
        staffEnabled: true,
        staffCompanyId: 'c1',
        staffRole: 'manager',
        platformAdminEnabled: true,
        existingClaims: { extra: 1 },
      },
    });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      expect(dry.wouldWrite).toBe(false);
      expect(dry.nextClaims.platformAdminEnabled).toBe(true);
      expect(dry.nextClaims.extra).toBe(1);
      expect(dry.requiresTokenRefresh).toBe(true);
    }

    const exec = decideClaimsSync({
      callerIsPlatform: true,
      mode: 'execute',
      target: { uid: 'u1' },
      snapshot: {
        staffEnabled: true,
        staffCompanyId: 'c1',
        staffRole: 'manager',
        existingClaims: {},
      },
    });
    expect(exec.ok && exec.wouldWrite).toBe(true);
  });

  it('will not set platformAdminEnabled without an enabled platform_admins record', () => {
    const r = decideClaimsSync({
      callerIsPlatform: true,
      mode: 'execute',
      target: { uid: 'u1' },
      snapshot: {
        staffEnabled: true,
        staffCompanyId: 'c1',
        staffRole: 'it',
        platformAdminEnabled: false,
        existingClaims: { platformAdminEnabled: true },
      },
    });
    expect(r.ok && r.nextClaims.platformAdminEnabled).toBe(false);
  });

  it('clears stale staff claims when the staff record is disabled', () => {
    const r = decideClaimsSync({
      callerIsPlatform: true,
      mode: 'execute',
      target: { uid: 'u1' },
      snapshot: {
        staffEnabled: false,
        staffCompanyId: 'c1',
        staffRole: 'manager',
        existingClaims: { staffCompanyId: 'c1', staffRole: 'manager', other: true },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nextClaims.staffCompanyId).toBeUndefined();
      expect(r.nextClaims.staffRole).toBeUndefined();
      expect(r.nextClaims.other).toBe(true);
    }
  });
});
