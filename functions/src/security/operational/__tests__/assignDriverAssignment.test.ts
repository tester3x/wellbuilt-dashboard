import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluateAssignDriverAssignment,
  isCanonicalDriverId,
} from '../assignDriverAssignment';

const DRIVER_ID = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const LEGACY_KEY = 'a'.repeat(64);

const profile = {
  exists: true as const,
  driverId: DRIVER_ID,
  active: true,
  companyId: 'liquid-gold',
  displayName: 'Mikezfold',
};

const legacyRow = {
  exists: true as const,
  key: LEGACY_KEY,
  active: true,
  companyId: 'liquid-gold',
  displayName: 'Mikezfold',
};

describe('evaluateAssignDriverAssignment', () => {
  it('writes canonical + legacy in one patch', () => {
    const r = evaluateAssignDriverAssignment({
      callerUid: 'admin-uid',
      isPlatformAdmin: true,
      driverId: DRIVER_ID,
      legacyKey: LEGACY_KEY,
      assignedRoutes: ['Gabriels', 'Watford'],
      profile,
      legacyRow,
      now: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dualWrite).toBe(true);
    expect(r.patch[`drivers/profiles/${DRIVER_ID}/assignedRoutes`]).toEqual(['Gabriels', 'Watford']);
    expect(r.patch[`drivers/approved/${LEGACY_KEY}/assignedRoutes`]).toEqual(['Gabriels', 'Watford']);
    const canon = Object.keys(r.patch).filter((k) => k.startsWith('drivers/profiles/'));
    const legacy = Object.keys(r.patch).filter((k) => k.startsWith('drivers/approved/'));
    expect(canon.length).toBeGreaterThan(0);
    expect(legacy.length).toBeGreaterThan(0);
  });

  it('refuses when legacy identity does not match canonical — no patch', () => {
    const r = evaluateAssignDriverAssignment({
      callerUid: 'admin-uid',
      isPlatformAdmin: true,
      driverId: DRIVER_ID,
      legacyKey: LEGACY_KEY,
      assignedRoutes: ['Gabriels'],
      profile,
      legacyRow: { ...legacyRow, displayName: 'SomeoneElse' },
    });
    expect(r).toEqual({ ok: false, reason: 'legacy_canonical_identity_mismatch' });
  });

  it('refuses missing legacy row when dual-write requested', () => {
    const r = evaluateAssignDriverAssignment({
      callerUid: 'admin-uid',
      isPlatformAdmin: true,
      driverId: DRIVER_ID,
      legacyKey: LEGACY_KEY,
      assignedRoutes: ['Gabriels'],
      profile,
      legacyRow: { exists: false },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('legacy_row_missing');
  });

  it('explicit empty array is a valid canonical write (ineligible, not omit)', () => {
    const r = evaluateAssignDriverAssignment({
      callerUid: 'admin-uid',
      isPlatformAdmin: true,
      driverId: DRIVER_ID,
      assignedRoutes: [],
      profile,
      legacyRow: { exists: false },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dualWrite).toBe(false);
    expect(r.patch[`drivers/profiles/${DRIVER_ID}/assignedRoutes`]).toEqual([]);
    expect(Object.keys(r.patch).some((k) => k.startsWith('drivers/approved/'))).toBe(false);
  });

  it('staff cannot assign across companies', () => {
    const r = evaluateAssignDriverAssignment({
      callerUid: 'staff',
      callerCompanyId: 'acme-eog-test',
      isPlatformAdmin: false,
      driverId: DRIVER_ID,
      assignedRoutes: ['Gabriels'],
      profile,
      legacyRow: { exists: false },
    });
    expect(r).toEqual({ ok: false, reason: 'cross_company' });
  });

  it('rejects a legacy hash used as driverId', () => {
    expect(isCanonicalDriverId(LEGACY_KEY)).toBe(false);
    const r = evaluateAssignDriverAssignment({
      callerUid: 'admin-uid',
      isPlatformAdmin: true,
      driverId: LEGACY_KEY,
      assignedRoutes: ['Gabriels'],
      profile,
      legacyRow: { exists: false },
    });
    expect(r).toEqual({ ok: false, reason: 'not_canonical_driver_id' });
  });

  it('Dashboard route assignment goes through the Admin callable, not a client RTDB write', () => {
    const src = readFileSync(
      join(__dirname, '../../../../../src/components/admin/DriversTab.tsx'),
      'utf8',
    );
    expect(src).toContain('adminAssignDriverAssignment');
    expect(src).not.toMatch(/update\(ref\(db,\s*`drivers\/approved\/\$\{routeTarget\.key\}`\),\s*\{\s*assignedRoutes/);
  });

  it('requires assignedRoutes to be an array', () => {
    const r = evaluateAssignDriverAssignment({
      callerUid: 'admin-uid',
      isPlatformAdmin: true,
      driverId: DRIVER_ID,
      assignedRoutes: null,
      profile,
      legacyRow: { exists: false },
    });
    expect(r).toEqual({ ok: false, reason: 'assigned_routes_must_be_array' });
  });
});
