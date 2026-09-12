import { assertExpectedOwner, assertLedgerOwner, emptyLedger, parseCompletion,
  recordCompletion, selectDvirEntry } from '../dvirCompletion';

const who = { driverId: 'driver-a', companyId: 'company-a' };
const oldShift = '2026-08-23_232617';
const current = { shiftId: '2026-09-12_110729', phase: 'pre_trip' as const };
const pre = { inspectionId: 'inspection-old', phase: 'pre_trip' as const,
  completedAt: '2026-08-23T23:30:00.000Z', reportDigest: 'a'.repeat(64) };
const pending = recordCompletion(emptyLedger(who, oldShift), pre);

test('old open DVIR routes to its Post-Trip instead of blocking the current request', () => {
  expect(selectDvirEntry([pending], who, current)).toEqual({
    binding: { shiftId: oldShift, phase: 'post_trip' }, recovery: true,
  });
});
test('closing the old Post-Trip lets the original request continue without modifying that shift', () => {
  const post = { ...pre, phase: 'post_trip' as const, completedAt: '2026-09-12T17:00:00.000Z', reportDigest: 'b'.repeat(64) };
  const closed = recordCompletion(pending, post);
  expect(closed.preTrip).toEqual(pre);
  expect(closed.postTripPending).toBe(false);
  expect(selectDvirEntry([closed], who, current)).toEqual({ binding: current, recovery: false });
});
test('another driver or company cannot redirect this account even with identical shift IDs', () => {
  expect(selectDvirEntry([{ ...pending, driverId: 'driver-b' },
    { ...pending, companyId: 'company-b' }], who, current)).toEqual({ binding: current, recovery: false });
});
test('current completed Pre-Trip does not force Post-Trip before work starts', () => {
  expect(selectDvirEntry([{ ...pending, shiftId: current.shiftId }], who, current))
    .toEqual({ binding: current, recovery: false });
});
test('an already-started current Post-Trip is resumed', () => {
  expect(selectDvirEntry([{ ...pending, shiftId: current.shiftId, postTripStarted: true }], who, current))
    .toEqual({ binding: { ...current, phase: 'post_trip' }, recovery: true });
});
test('oldest outstanding shift is selected deterministically', () => {
  expect(selectDvirEntry([{ ...pending, shiftId: '2026-09-01_120000' }, pending], who, current).binding.shiftId)
    .toBe(oldShift);
});
test('Post-Trip-only legacy recovery does not invent a Pre-Trip', () => {
  const draft = { ...emptyLedger(who, oldShift), postTripPending: true, postTripStarted: true };
  expect(selectDvirEntry([draft], who, current).binding.phase).toBe('post_trip');
  const closed = recordCompletion(draft, { ...pre, phase: 'post_trip' });
  expect(closed.preTrip).toBeNull();
  expect(closed.postTripPending).toBe(false);
});
test('duplicate completion is immutable and cannot reopen a closed Post-Trip', () => {
  expect(recordCompletion(pending, pre)).toBe(pending);
  expect(() => recordCompletion(pending, { ...pre, reportDigest: 'b'.repeat(64) })).toThrow('conflict');
  const postFirst = recordCompletion(emptyLedger(who, oldShift), { ...pre, phase: 'post_trip' });
  expect(recordCompletion(postFirst, pre).postTripPending).toBe(false);
});
test('in-flight account changes and stored tenant mismatches are rejected', () => {
  expect(() => assertExpectedOwner({ expectedDriverId: 'driver-b', expectedCompanyId: who.companyId }, who)).toThrow();
  expect(() => assertExpectedOwner({ expectedDriverId: who.driverId, expectedCompanyId: 'company-b' }, who)).toThrow();
  expect(() => assertLedgerOwner({ ...pending, companyId: 'company-b' }, who, oldShift)).toThrow();
});
test('old signed completions can be backfilled; malformed and future completions cannot', () => {
  const now = Date.parse('2026-09-12T17:00:00Z');
  expect(parseCompletion(pre, now)).toEqual(pre);
  for (const invalid of [{ ...pre, phase: 'draft' }, { ...pre, reportDigest: '' },
    { ...pre, completedAt: '2027-01-01T00:00:00Z' }, { ...pre, inspectionId: '../other' }]) {
    expect(() => parseCompletion(invalid, now)).toThrow();
  }
});
