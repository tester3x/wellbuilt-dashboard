/**
 * Equipment issuance period authority — decideEquipmentAuthorization
 * reuses decideResolve. Origin-day driver_shifts docs cannot veto.
 */
import { decideEquipmentAuthorization } from '../equipmentAuthorization';
import { decideResolve, type ShiftAuthorityRecord } from '../../security/operational/shiftAuthority';
import type { WellbuiltContract } from '../../admin/companyContract';
import type { PlanDefinition } from '@tester3x/wellbuilt-contracts';

const DRIVER = 'driver-mikezfold';
const COMPANY = 'liquid-gold';
const PERIOD = '2026-08-21_112421';
const DAY = '2026-08-21';
const OTHER = '2026-08-22_070000';
const NOW = Date.parse('2026-08-23T20:16:00Z');

const CONTRACT: WellbuiltContract = {
  contractVersion: 1,
  configurationVersion: 1,
  planId: 'plan-1',
  entitlementOverrides: [],
  workPeriodConfiguration: { mode: 'explicit_shift' },
  contractEnforced: true,
};

const PLAN = {
  contractVersion: 1,
  planId: 'plan-1',
  displayName: 'P',
  capabilities: ['dvir', 'explicitShiftLifecycle'],
  status: 'active',
} as PlanDefinition;

const openAuth = (): ShiftAuthorityRecord => ({
  driverId: DRIVER,
  companyId: COMPANY,
  initialized: true,
  openPeriodId: PERIOD,
  originLocalDate: DAY,
  version: 4,
});

const closedAuth = (): ShiftAuthorityRecord => ({
  driverId: DRIVER,
  companyId: COMPANY,
  initialized: true,
  openPeriodId: null,
  originLocalDate: null,
  lastClosedPeriodId: PERIOD,
  version: 5,
});

const originClosed = { readable: true, present: true, currentShiftId: '' as const };
const originMissing = { readable: true, present: false };
const originOpen = { readable: true, present: true, currentShiftId: PERIOD };

function decide(over: Partial<Parameters<typeof decideEquipmentAuthorization>[0]> = {}) {
  return decideEquipmentAuthorization({
    driverId: DRIVER,
    companyId: COMPANY,
    binding: { shiftId: PERIOD, phase: 'post_trip' },
    contract: CONTRACT,
    contractState: 'active',
    plan: PLAN,
    authority: openAuth(),
    originDayDoc: originClosed,
    nowMs: NOW,
    ...over,
  });
}

describe('decideEquipmentAuthorization canonical period', () => {
  test('reuses decideResolve: open canonical + closed origin-day issues', () => {
    const auth = openAuth();
    expect(decideResolve(auth, { driverId: DRIVER, companyId: COMPANY })).toEqual({
      state: 'open', periodId: PERIOD, originLocalDate: DAY,
    });
    const d = decide({ authority: auth, originDayDoc: originClosed });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.binding).toEqual({ shiftId: PERIOD, phase: 'post_trip' });
    }
  });

  test('open canonical + missing origin-day issues (origin-day is not required)', () => {
    const d = decide({ originDayDoc: originMissing });
    expect(d.ok).toBe(true);
  });

  test('open canonical + absent origin-day snapshot issues', () => {
    const d = decide({ originDayDoc: null });
    expect(d.ok).toBe(true);
  });

  test('canonical closed denies even if origin-day still says open', () => {
    const d = decide({ authority: closedAuth(), originDayDoc: originOpen });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe('shift_not_active');
      expect(d.detail).toBe('closed');
    }
  });

  test('canonical superseded/replaced denies', () => {
    const auth: ShiftAuthorityRecord = {
      ...openAuth(),
      openPeriodId: OTHER,
      originLocalDate: '2026-08-22',
      lastClosedPeriodId: PERIOD,
      version: 6,
    };
    const d = decide({ authority: auth });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe('shift_id_mismatch');
      expect(d.detail).toBe('superseded');
    }
  });

  test('periodId mismatch denies', () => {
    const d = decide({ binding: { shiftId: OTHER, phase: 'post_trip' } });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('shift_id_mismatch');
  });

  test('driver mismatch denies', () => {
    const d = decide({ authority: { ...openAuth(), driverId: 'other-driver' } });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('driver_mismatch');
  });

  test('company mismatch denies', () => {
    const d = decide({ authority: { ...openAuth(), companyId: 'other-co' } });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('company_mismatch');
  });

  test('missing canonical period denies', () => {
    const d = decide({ authority: null, originDayDoc: originOpen });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe('period_missing');
  });

  test('uninitialized canonical period denies', () => {
    const d = decide({
      authority: { ...openAuth(), initialized: false },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe('period_missing');
      expect(d.detail).toBe('authority_uninitialized');
    }
  });
});
