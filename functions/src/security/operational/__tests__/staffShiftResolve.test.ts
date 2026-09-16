import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MAX_STAFF_SHIFT_DRIVER_IDS,
  normalizeDriverIds,
  resolveStaffScopeCompany,
  buildStaffShiftResult,
} from '../staffShiftResolveCore';
import { decideResolve, type ShiftAuthorityRecord } from '../shiftAuthority';

const MIKE = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const S24 = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const asOf = '2026-09-15T00:00:00.000Z';

const rec = (over: Partial<ShiftAuthorityRecord>): ShiftAuthorityRecord => ({
  driverId: MIKE, companyId: 'liquid-gold', initialized: true,
  openPeriodId: null, originLocalDate: null, version: 1, ...over,
});

describe('staff shift resolve — input validation', () => {
  it('rejects non-array, empty, and oversized input', () => {
    expect(normalizeDriverIds('x')).toEqual({ ok: false, reason: 'not_array' });
    expect(normalizeDriverIds([])).toEqual({ ok: false, reason: 'empty' });
    const many = Array.from({ length: MAX_STAFF_SHIFT_DRIVER_IDS + 1 }, (_, i) => `d${i}`);
    expect(normalizeDriverIds(many)).toEqual({ ok: false, reason: 'too_many' });
  });
  it('rejects a non-string / blank id', () => {
    expect(normalizeDriverIds([MIKE, 123]).ok).toBe(false);
    expect(normalizeDriverIds([MIKE, '  ']).ok).toBe(false);
  });
  it('trims and de-dupes ids', () => {
    expect(normalizeDriverIds([` ${MIKE} `, MIKE, S24])).toEqual({ ok: true, ids: [MIKE, S24] });
  });
});

describe('staff shift resolve — company scope (never trust the client)', () => {
  it('company-scoped staff use their OWN company; client companyId is ignored', () => {
    const r = resolveStaffScopeCompany({ companyId: 'liquid-gold', isPlatformAdmin: false, caps: [] }, 'acme');
    expect(r).toEqual({ ok: true, companyId: 'liquid-gold' });
  });
  it('platform admin WITH viewAllCompanies may target a company', () => {
    const r = resolveStaffScopeCompany({ isPlatformAdmin: true, caps: ['viewAllCompanies'] }, 'acme');
    expect(r).toEqual({ ok: true, companyId: 'acme' });
  });
  it('unauthorized/unscoped caller is rejected', () => {
    expect(resolveStaffScopeCompany({ isPlatformAdmin: false, caps: [] }, 'acme').ok).toBe(false);
    expect(resolveStaffScopeCompany({ isPlatformAdmin: true, caps: [] }, 'acme').ok).toBe(false); // no viewAllCompanies
  });
});

describe('staff shift resolve — per-driver governed decision (reuses decideResolve)', () => {
  const per = (record: ShiftAuthorityRecord | null, driverId: string, companyId: string) =>
    buildStaffShiftResult(driverId, decideResolve(record, { driverId, companyId }), asOf);

  it('open shift → open (Mike)', () => {
    expect(per(rec({ openPeriodId: '2026-09-13_091427', originLocalDate: '2026-09-13' }), MIKE, 'liquid-gold'))
      .toEqual({ driverId: MIKE, state: 'open', asOf });
  });
  it('no open period → none (Michael S24)', () => {
    expect(per(rec({ driverId: S24, lastClosedPeriodId: '2026-09-12_020000' }), S24, 'liquid-gold'))
      .toEqual({ driverId: S24, state: 'none', asOf });
  });
  it('missing authority record → unverifiable', () => {
    expect(per(null, MIKE, 'liquid-gold')).toEqual({ driverId: MIKE, state: 'unverifiable', asOf });
  });
  it('wrong company cannot match (cross-company → unverifiable, never leaked)', () => {
    // Mike's record is liquid-gold; a caller scoped to acme resolving Mike's id gets driver_mismatch.
    expect(per(rec({ openPeriodId: '2026-09-13_091427', originLocalDate: '2026-09-13' }), MIKE, 'acme').state)
      .toBe('unverifiable');
  });
  it('mixed batch resolves each id independently by canonical driverId + company', () => {
    const records = new Map<string, ShiftAuthorityRecord | null>([
      [MIKE, rec({ openPeriodId: '2026-09-13_091427', originLocalDate: '2026-09-13' })],
      [S24, rec({ driverId: S24 })],
      ['ghost', null],
    ]);
    const out = [MIKE, S24, 'ghost'].map((id) => per(records.get(id) ?? null, id, 'liquid-gold'));
    expect(out.map((o) => o.state)).toEqual(['open', 'none', 'unverifiable']);
  });
});

describe('staff shift resolve — callable is read-only and correctly wired', () => {
  const src = readFileSync(join(__dirname, '../shiftAuthorityCallables.ts'), 'utf8');
  // Isolate ONLY the staff-resolve callable body (from its definition to the next export).
  const defStart = src.indexOf('export const staffResolveCompanyDriverShifts');
  const afterDef = src.slice(defStart + 'export const staffResolveCompanyDriverShifts'.length);
  const nextExport = afterDef.indexOf('\nexport const ');
  const body = nextExport >= 0 ? afterDef.slice(0, nextExport) : afterDef;
  it('the callable exists, authorizes a registered dashboard user, and never writes', () => {
    expect(defStart).toBeGreaterThan(-1);
    expect(src).toMatch(/export const staffResolveCompanyDriverShifts = httpsV2\.onCall/);
    expect(body).toMatch(/requireRegisteredDashboardUser/);
    expect(body).toMatch(/resolveStaffScopeCompany/);
    expect(body).toMatch(/decideResolve/);
    // Read-only: no set/update/add/delete/FieldValue write in the staff-resolve body.
    expect(body).not.toMatch(/\.set\(|\.update\(|\.add\(|\.delete\(|FieldValue\./);
  });
  it('does NOT require manageDrivers (dispatchers/viewers keep their dots)', () => {
    expect(body).not.toMatch(/requireManageDrivers/);
  });
});
