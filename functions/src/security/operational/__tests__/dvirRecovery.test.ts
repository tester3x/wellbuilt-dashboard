import { isDvirRecovery, parseRecoveryFeedback } from '../dvirRecovery';
import { emptyLedger } from '../dvirCompletion';
const who = { driverId: 'driver-a', companyId: 'company-a' };
const shiftId = '2026-09-11_080000';
const ledger = { ...emptyLedger(who, shiftId), postTripPending: true };
const authority = { ...who, initialized: true, openPeriodId: null };
describe('Post-Trip recovery authorization', () => {
  test('off-shift pending inspection qualifies; no shift is created', () => {
    expect(isDvirRecovery(ledger, who, authority)).toBe(true);
    expect(authority.openPeriodId).toBeNull();
  });
  test('normal active-shift Post-Trip never becomes forced recovery', () => {
    expect(isDvirRecovery(ledger, who, { ...authority, openPeriodId: shiftId })).toBe(false);
    expect(isDvirRecovery(ledger, who, { ...authority, openPeriodId: '2026-09-12_080000' })).toBe(true);
  });
  test('foreign, missing, unverified and completed records do not authorize', () => {
    expect(isDvirRecovery(ledger, who, null)).toBe(false);
    expect(isDvirRecovery(ledger, who, { ...authority, initialized: false })).toBe(false);
    expect(isDvirRecovery({ ...ledger, driverId: 'foreign' }, who, authority)).toBe(false);
    expect(isDvirRecovery(ledger, who, { ...authority, companyId: 'foreign' })).toBe(false);
    expect(isDvirRecovery({ ...ledger, postTripPending: false }, who, authority)).toBe(false);
    expect(isDvirRecovery({ ...ledger, postTrip: { phase: 'post_trip', inspectionId: 'x', completedAt: 'x', reportDigest: 'x' } }, who, authority)).toBe(false);
  });
  test('feedback is optional context and has bounded validated content', () => {
    expect(parseRecoveryFeedback({ reason: 'app_or_connection', note: '  lost signal  ' }).note).toBe('lost signal');
    expect(() => parseRecoveryFeedback({ reason: 'blame_driver' })).toThrow();
    expect(() => parseRecoveryFeedback({ reason: 'other', note: 'a'.repeat(501) })).toThrow();
  });
});
