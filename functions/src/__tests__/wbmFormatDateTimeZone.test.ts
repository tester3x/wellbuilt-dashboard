// Hard Blocker 1 — timestamp consistency: the edit apply RE-DERIVES the local
// `dateTime` string from the edited `dateTimeUTC` + timezone via
// formatLocalDateTimeInZone, so the two can never diverge. These tests pin the
// canonical unpadded "M/D/YYYY h:mm AM/PM" format, timezone correctness across
// CST/CDT and DST boundaries, and safe handling of bad input.

import { formatLocalDateTimeInZone } from '../wbmFormat';

describe('formatLocalDateTimeInZone — canonical local dateTime from an instant', () => {
  test('renders America/Chicago wall clock (CDT, UTC-5) unpadded', () => {
    // 2026-09-02T22:59:00Z = 5:59 PM CDT
    expect(formatLocalDateTimeInZone('2026-09-02T22:59:00.000Z', 'America/Chicago'))
      .toBe('9/2/2026 5:59 PM');
  });

  test('matches the client format exactly: no padding on month/day/hour, 2-digit minute', () => {
    // 2026-01-05T13:07:00Z = 7:07 AM CST (UTC-6 in winter)
    expect(formatLocalDateTimeInZone('2026-01-05T13:07:00.000Z', 'America/Chicago'))
      .toBe('1/5/2026 7:07 AM');
  });

  test('midnight renders as 12:xx AM (not 0 or 24)', () => {
    // 2026-06-15T05:03:00Z = 12:03 AM CDT
    expect(formatLocalDateTimeInZone('2026-06-15T05:03:00.000Z', 'America/Chicago'))
      .toBe('6/15/2026 12:03 AM');
  });

  test('noon renders as 12:xx PM', () => {
    // 2026-06-15T17:00:00Z = 12:00 PM CDT
    expect(formatLocalDateTimeInZone('2026-06-15T17:00:00.000Z', 'America/Chicago'))
      .toBe('6/15/2026 12:00 PM');
  });

  test('honors a DIFFERENT timezone (America/New_York)', () => {
    // 2026-09-02T22:59:00Z = 6:59 PM EDT
    expect(formatLocalDateTimeInZone('2026-09-02T22:59:00.000Z', 'America/New_York'))
      .toBe('9/2/2026 6:59 PM');
  });

  test('respects DST: the same wall-clock hour maps to different UTC across the boundary', () => {
    // 2026-03-08 02:00 local is the US spring-forward. 07:30Z:
    //   before ~ CST (UTC-6): 1:30 AM ; but 08:30Z after clocks jump = 3:30 AM CDT
    expect(formatLocalDateTimeInZone('2026-03-08T07:30:00.000Z', 'America/Chicago'))
      .toBe('3/8/2026 1:30 AM');
    expect(formatLocalDateTimeInZone('2026-03-08T08:30:00.000Z', 'America/Chicago'))
      .toBe('3/8/2026 3:30 AM'); // 2:xx does not exist; clocks jumped to 3:xx
  });

  test('day boundary: an instant that is one local day flips the date correctly', () => {
    // 2026-09-03T04:30:00Z = 11:30 PM CDT on 9/2 (still previous local day)
    expect(formatLocalDateTimeInZone('2026-09-03T04:30:00.000Z', 'America/Chicago'))
      .toBe('9/2/2026 11:30 PM');
    // 2026-09-03T05:30:00Z = 12:30 AM CDT on 9/3
    expect(formatLocalDateTimeInZone('2026-09-03T05:30:00.000Z', 'America/Chicago'))
      .toBe('9/3/2026 12:30 AM');
  });

  test('blank/absent timezone defaults to America/Chicago (company TZ)', () => {
    expect(formatLocalDateTimeInZone('2026-09-02T22:59:00.000Z', '')).toBe('9/2/2026 5:59 PM');
    expect(formatLocalDateTimeInZone('2026-09-02T22:59:00.000Z', undefined)).toBe('9/2/2026 5:59 PM');
    expect(formatLocalDateTimeInZone('2026-09-02T22:59:00.000Z', null)).toBe('9/2/2026 5:59 PM');
  });

  test('invalid instant or timezone → empty string (caller preserves prior value)', () => {
    expect(formatLocalDateTimeInZone('', 'America/Chicago')).toBe('');
    expect(formatLocalDateTimeInZone('not-a-date', 'America/Chicago')).toBe('');
    expect(formatLocalDateTimeInZone('2026-09-02T22:59:00.000Z', 'Not/AZone')).toBe('');
  });

  test('round-trips a client-produced instant back to the same string', () => {
    // Simulate: driver in Chicago edits time to 6:59 PM → client computes UTC.
    // 6:59 PM CDT = 2026-09-02T23:59:00Z. Server must derive back to 6:59 PM.
    const iso = '2026-09-02T23:59:00.000Z';
    expect(formatLocalDateTimeInZone(iso, 'America/Chicago')).toBe('9/2/2026 6:59 PM');
  });
});
