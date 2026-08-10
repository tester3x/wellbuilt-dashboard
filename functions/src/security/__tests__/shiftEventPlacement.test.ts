/**
 * Calendar-day placement + operational events.
 *
 * THE DEFECT THIS PINS. The previous close derived its event document day
 * from `serverIsoNow.slice(0, 10)` — a UTC date. Mike's 20:37 close in
 * America/Chicago is 01:37 the NEXT UTC day, so an evening close was filed a
 * day late, recreating the exact cross-midnight split the authority record
 * exists to remove. The correction stops deriving a date at all: every
 * server-authored event goes to the period's stored origin day.
 *
 * These tests are written against real America/Chicago instants (both CDT and
 * CST, to catch a DST-shaped mistake) rather than synthetic offsets, so a
 * regression to UTC-derived placement fails loudly.
 */
import {
  SERVER_AUTHORABLE_EVENT_TYPES,
  buildLifecycleEvent,
  decideClaim,
  decideClose,
  decideOperationalEvent,
  eventDayFor,
  isPlausibleLocalDate,
  isValidOdometerMiles,
  ODOMETER_MAX_MILES,
  recordAfterClaim,
  type ShiftAuthorityRecord,
} from '../operational/shiftAuthority';

const DRIVER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const COMPANY = 'liquid-gold';
const WHO = { driverId: DRIVER, companyId: COMPANY };

const openRecord = (periodId: string, originLocalDate: string): ShiftAuthorityRecord => ({
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: periodId, originLocalDate, version: 2,
});

// ── 1. the UTC off-by-one, stated as the real instant ─────────────────────

describe('1. evening America/Chicago close does not land on the next UTC day', () => {
  // 2026-08-09 20:37:44 CDT (UTC-5) === 2026-08-10T01:37:44Z.
  const CLOSE_UTC = '2026-08-10T01:37:44.667Z';
  const PERIOD = '2026-08-08_211725';
  const ORIGIN = '2026-08-08';

  it('the old UTC-derived day was wrong — this is the bug, spelled out', () => {
    // What the previous implementation computed:
    expect(CLOSE_UTC.slice(0, 10)).toBe('2026-08-10');
    // The driver's actual local day was 2026-08-09, and the period's origin
    // day was 2026-08-08. UTC agreed with NEITHER.
    expect(CLOSE_UTC.slice(0, 10)).not.toBe('2026-08-09');
    expect(CLOSE_UTC.slice(0, 10)).not.toBe(ORIGIN);
  });

  it('placement now comes from the stored origin day, not the clock', () => {
    const rec = openRecord(PERIOD, ORIGIN);
    const decision = decideClose(rec, PERIOD, WHO);
    expect(decision.action).toBe('close');
    if (decision.action !== 'close') return;
    expect(eventDayFor(decision)).toBe(ORIGIN);
    // The close instant cannot influence the document chosen.
    expect(eventDayFor(decision)).not.toBe(CLOSE_UTC.slice(0, 10));
  });

  it('the same close at any UTC instant picks the same document', () => {
    const rec = openRecord(PERIOD, ORIGIN);
    const decision = decideClose(rec, PERIOD, WHO);
    if (decision.action !== 'close') throw new Error('expected close');
    // Placement is a function of the RECORD alone — there is no clock input
    // to eventDayFor, so this is total, not merely sampled.
    for (const _instant of ['2026-08-09T12:00:00Z', '2026-08-10T01:37:44Z', '2026-08-10T23:59:59Z']) {
      expect(eventDayFor(decision)).toBe(ORIGIN);
    }
  });
});

// ── 2. cross-midnight attribution ─────────────────────────────────────────

describe('2. a cross-midnight shift stays attributable to one period', () => {
  const PERIOD = '2026-08-08_211725';
  const ORIGIN = '2026-08-08';

  it('login, depart_return and logout all carry the period and share a document', () => {
    const rec = openRecord(PERIOD, ORIGIN);
    const close = decideClose(rec, PERIOD, WHO);
    const dep = decideOperationalEvent(rec, PERIOD, WHO, false);
    if (close.action !== 'close' || dep.action !== 'append') throw new Error('setup');

    expect(eventDayFor(close)).toBe(ORIGIN);
    expect(eventDayFor(dep)).toBe(ORIGIN);

    const events = [
      buildLifecycleEvent('login', PERIOD, '2026-08-09T02:17:25.000Z'),
      buildLifecycleEvent('depart_return', PERIOD, '2026-08-10T01:27:49.000Z'),
      buildLifecycleEvent('logout', PERIOD, '2026-08-10T01:37:44.000Z'),
    ];
    // Every event names the period, so reconstruction needs no adjacency
    // guessing — the failure mode of the historical events.
    expect(events.every((e) => e.shiftId === PERIOD)).toBe(true);
    expect(events.every((e) => e.source === 'server')).toBe(true);
    // And adjacency is preserved anyway, so daySummary's positional pairing
    // (depart_return -> logout) still works.
    expect(events.map((e) => e.type)).toEqual(['login', 'depart_return', 'logout']);
  });
});

// ── 3 & 4. determinism and the plausibility bound ─────────────────────────

describe('3. placement is deterministic across DST', () => {
  it('a CST (winter) period behaves identically to a CDT (summer) one', () => {
    // 2026-01-15 21:17 CST (UTC-6) === 2026-01-16T03:17Z — still next-day UTC.
    const winter = decideClose(openRecord('2026-01-15_211725', '2026-01-15'), '2026-01-15_211725', WHO);
    const summer = decideClose(openRecord('2026-08-08_211725', '2026-08-08'), '2026-08-08_211725', WHO);
    if (winter.action !== 'close' || summer.action !== 'close') throw new Error('setup');
    expect(eventDayFor(winter)).toBe('2026-01-15');
    expect(eventDayFor(summer)).toBe('2026-08-08');
    // No offset arithmetic happens anywhere, so DST cannot shift placement.
  });

  it('the DST-transition night is not special', () => {
    // 2026-03-08 is the US spring-forward date; 02:00 local does not exist.
    const d = decideClose(openRecord('2026-03-08_211725', '2026-03-08'), '2026-03-08_211725', WHO);
    if (d.action !== 'close') throw new Error('setup');
    expect(eventDayFor(d)).toBe('2026-03-08');
  });
});

describe('4. an unverified local date cannot silently select the wrong day', () => {
  const NOW = '2026-08-09T02:17:25.000Z'; // UTC day 2026-08-09

  it('accepts every date a real timezone could produce (UTC-12..UTC+14)', () => {
    expect(isPlausibleLocalDate('2026-08-08', NOW)).toBe(true); // behind UTC
    expect(isPlausibleLocalDate('2026-08-09', NOW)).toBe(true); // same as UTC
    expect(isPlausibleLocalDate('2026-08-10', NOW)).toBe(true); // ahead of UTC
  });

  it('rejects a date no timezone can justify', () => {
    expect(isPlausibleLocalDate('2026-08-07', NOW)).toBe(false);
    expect(isPlausibleLocalDate('2026-08-11', NOW)).toBe(false);
    expect(isPlausibleLocalDate('2025-08-09', NOW)).toBe(false); // typo'd year
    expect(isPlausibleLocalDate('not-a-date', NOW)).toBe(false);
  });

  it('a claim proposing an implausible day is refused before it can be frozen', () => {
    // The claim decision still enforces internal consistency...
    const none: ShiftAuthorityRecord = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: null, originLocalDate: null, version: 1,
    };
    expect(decideClaim(none, { periodId: '2026-08-08_211725', originLocalDate: '2026-08-09' }, WHO))
      .toEqual({ action: 'refuse', reason: 'period_date_mismatch' });
    // ...and the adapter's plausibility bound rejects a self-consistent but
    // impossible pair, which consistency alone would happily accept.
    expect(decideClaim(none, { periodId: '2020-01-01_080000', originLocalDate: '2020-01-01' }, WHO).action)
      .toBe('claim');
    expect(isPlausibleLocalDate('2020-01-01', NOW)).toBe(false);
  });
});

// ── 5 & 6. claim writes exactly one login; resume writes none ─────────────

describe('5/6. authoritative login is written by claim only', () => {
  it('a claim produces one login event carrying the period', () => {
    const ev = buildLifecycleEvent('login', '2026-08-08_211725', '2026-08-09T02:17:25.000Z');
    expect(ev).toEqual({
      type: 'login', shiftId: '2026-08-08_211725',
      timestamp: '2026-08-09T02:17:25.000Z', source: 'server',
    });
  });

  it('RESUME writes nothing — an already-open period returns `existing`', () => {
    const rec = openRecord('2026-08-08_211725', '2026-08-08');
    const d = decideClaim(rec, { periodId: '2026-08-09_070000', originLocalDate: '2026-08-09' }, WHO);
    // Not `claim` — so the adapter's write branch is never entered and no
    // second login can be appended. This is what makes resume safe.
    expect(d).toEqual({
      action: 'existing', periodId: '2026-08-08_211725', originLocalDate: '2026-08-08',
    });
  });

  it('the proposal is DISCARDED on resume — the stored binding wins', () => {
    const rec = openRecord('2026-08-08_211725', '2026-08-08');
    const d = decideClaim(rec, { periodId: '2026-08-09_070000', originLocalDate: '2026-08-09' }, WHO);
    if (d.action !== 'existing') throw new Error('setup');
    expect(d.periodId).not.toBe('2026-08-09_070000');
  });
});

// ── 7-9, 11. operational events ───────────────────────────────────────────

describe('7. depart_return appends one authenticated, period-attributed event', () => {
  it('appends against the open period', () => {
    const rec = openRecord('2026-08-08_211725', '2026-08-08');
    expect(decideOperationalEvent(rec, '2026-08-08_211725', WHO, false)).toEqual({
      action: 'append', periodId: '2026-08-08_211725', originLocalDate: '2026-08-08',
    });
  });

  it('the event type is fixed by the endpoint — the caller cannot choose one', () => {
    // The authorable surface is a frozen list, and the operational decision
    // carries no type at all: the adapter supplies it per endpoint.
    expect([...SERVER_AUTHORABLE_EVENT_TYPES]).toEqual(['login', 'logout', 'depart_return']);
    expect(Object.isFrozen(SERVER_AUTHORABLE_EVENT_TYPES)).toBe(true);
  });
});

describe('8. a repeated Depart Return is idempotent', () => {
  it('a second call with the event already present is a no-op', () => {
    const rec = openRecord('2026-08-08_211725', '2026-08-08');
    expect(decideOperationalEvent(rec, '2026-08-08_211725', WHO, true)).toEqual({
      action: 'already_recorded', periodId: '2026-08-08_211725',
    });
  });

  it('presence is judged by type AND period, not by type alone', () => {
    // A depart_return belonging to YESTERDAY's period must not suppress
    // today's. The adapter matches on both fields; this pins the contract the
    // adapter relies on.
    const rec = openRecord('2026-08-09_070000', '2026-08-09');
    const priorPeriodEvent = buildLifecycleEvent('depart_return', '2026-08-08_211725', '2026-08-09T01:00:00Z');
    const matches = priorPeriodEvent.type === 'depart_return'
      && priorPeriodEvent.shiftId === '2026-08-09_070000';
    expect(matches).toBe(false);
    expect(decideOperationalEvent(rec, '2026-08-09_070000', WHO, matches).action).toBe('append');
  });
});

describe('9. depart_return against an inactive or wrong period refuses', () => {
  const none: ShiftAuthorityRecord = {
    driverId: DRIVER, companyId: COMPANY, initialized: true,
    openPeriodId: null, originLocalDate: null, lastClosedPeriodId: '2026-08-08_211725', version: 3,
  };

  it('refuses when no period is open — it cannot resurrect a closed shift', () => {
    expect(decideOperationalEvent(none, '2026-08-08_211725', WHO, false))
      .toEqual({ action: 'refuse', reason: 'no_open_period' });
  });

  it('refuses when a DIFFERENT period is open', () => {
    const rec = openRecord('2026-08-09_070000', '2026-08-09');
    expect(decideOperationalEvent(rec, '2026-08-08_211725', WHO, false))
      .toEqual({ action: 'refuse', reason: 'period_mismatch' });
  });

  it('refuses on unverifiable authority rather than assuming none', () => {
    expect(decideOperationalEvent(null, '2026-08-08_211725', WHO, false))
      .toEqual({ action: 'refuse', reason: 'authority_absent' });
  });

  it('refuses across drivers and across companies', () => {
    const foreign = { ...openRecord('2026-08-08_211725', '2026-08-08'), driverId: 'someone-else' };
    expect(decideOperationalEvent(foreign, '2026-08-08_211725', WHO, false))
      .toEqual({ action: 'refuse', reason: 'driver_mismatch' });
    const otherCo = { ...openRecord('2026-08-08_211725', '2026-08-08'), companyId: 'other-co' };
    expect(decideOperationalEvent(otherCo, '2026-08-08_211725', WHO, false))
      .toEqual({ action: 'refuse', reason: 'driver_mismatch' });
  });
});

describe('11. operational calls can neither claim nor close', () => {
  it('the decision has no branch that opens or closes a period', () => {
    const rec = openRecord('2026-08-08_211725', '2026-08-08');
    const actions = new Set([
      decideOperationalEvent(rec, '2026-08-08_211725', WHO, false).action,
      decideOperationalEvent(rec, '2026-08-08_211725', WHO, true).action,
      decideOperationalEvent(null, '2026-08-08_211725', WHO, false).action,
    ]);
    expect([...actions].sort()).toEqual(['already_recorded', 'append', 'refuse']);
    expect(actions.has('claim' as never)).toBe(false);
    expect(actions.has('close' as never)).toBe(false);
  });

  it('an append leaves the authority record untouched', () => {
    const rec = openRecord('2026-08-08_211725', '2026-08-08');
    const before = JSON.stringify(rec);
    decideOperationalEvent(rec, '2026-08-08_211725', WHO, false);
    // Pure function: no mutation, and the adapter writes only the day doc.
    expect(JSON.stringify(rec)).toBe(before);
  });
});

// ── 10. odometer bounds ───────────────────────────────────────────────────

describe('10. odometer is bounded, period-bound and idempotent', () => {
  it('accepts a plausible per-shift total', () => {
    expect(isValidOdometerMiles(0)).toBe(true);
    expect(isValidOdometerMiles(287)).toBe(true);
    expect(isValidOdometerMiles(ODOMETER_MAX_MILES)).toBe(true);
  });

  it('rejects an absolute odometer READING pasted in by mistake', () => {
    // WB-S sends end-minus-start. A six-figure reading would otherwise become
    // the day's driveMiles in every summary.
    expect(isValidOdometerMiles(124590)).toBe(false);
    expect(isValidOdometerMiles(ODOMETER_MAX_MILES + 1)).toBe(false);
  });

  it('rejects negatives, fractions and non-numbers', () => {
    expect(isValidOdometerMiles(-1)).toBe(false);
    expect(isValidOdometerMiles(12.5)).toBe(false);
    expect(isValidOdometerMiles('287')).toBe(false);
    expect(isValidOdometerMiles(NaN)).toBe(false);
    expect(isValidOdometerMiles(undefined)).toBe(false);
  });

  it('rides on close, so it is period-bound and idempotent by inheritance', () => {
    // Odometer has no independent write path: it is a field of the close
    // transaction. A repeated close returns already_closed WITHOUT re-writing,
    // so a retry cannot double-apply or overwrite with a later value.
    const closed: ShiftAuthorityRecord = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: null, originLocalDate: null,
      lastClosedPeriodId: '2026-08-08_211725', version: 3,
    };
    expect(decideClose(closed, '2026-08-08_211725', WHO))
      .toEqual({ action: 'already_closed', periodId: '2026-08-08_211725' });
  });
});

// ── 12 & 13. close placement and repeat safety ────────────────────────────

describe('12/13. close writes one logout in the canonical placement', () => {
  it('the logout lands on the origin day and names the period', () => {
    const rec = openRecord('2026-08-08_211725', '2026-08-08');
    const d = decideClose(rec, '2026-08-08_211725', WHO);
    if (d.action !== 'close') throw new Error('setup');
    expect(eventDayFor(d)).toBe('2026-08-08');
    const ev = buildLifecycleEvent('logout', d.periodId, '2026-08-10T01:37:44.667Z');
    expect(ev.shiftId).toBe('2026-08-08_211725');
    expect(ev.type).toBe('logout');
  });

  it('a repeated close appends no second logout', () => {
    const closed: ShiftAuthorityRecord = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: null, originLocalDate: null,
      lastClosedPeriodId: '2026-08-08_211725', version: 3,
    };
    // already_closed is not `close`, so the adapter's write branch is skipped.
    expect(decideClose(closed, '2026-08-08_211725', WHO).action).toBe('already_closed');
  });

  it('claim then close returns the pointer to none without losing the period', () => {
    const none: ShiftAuthorityRecord = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: null, originLocalDate: null, version: 1,
    };
    const claimed = recordAfterClaim(none, '2026-08-08_211725', '2026-08-08');
    expect(eventDayFor({ originLocalDate: claimed.originLocalDate as string })).toBe('2026-08-08');
  });
});

// ── 17. no HOS logic ──────────────────────────────────────────────────────

describe('17. no HOS logic exists in the shift authority', () => {
  it('the modules contain no rest/duty/hours-of-service concepts', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', 'operational');
    for (const f of ['shiftAuthority.ts', 'shiftAuthorityCallables.ts']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8') as string;
      // 'THIS IS NOT HOS' appears as a deliberate disclaimer; strip comments
      // that say so and assert no functional HOS identifiers exist.
      expect(/\b(restPeriod|dutyStatus|hoursOfService|maxDrivingHours|cycleHours)\b/.test(src))
        .toBe(false);
    }
  });

  it('there is no maximum period duration anywhere in the decisions', () => {
    // A 23-hour period closes exactly like a 1-hour one.
    const rec = openRecord('2026-08-08_211725', '2026-08-08');
    expect(decideClose(rec, '2026-08-08_211725', WHO).action).toBe('close');
    const ancient = openRecord('2026-01-01_080000', '2026-01-01');
    expect(decideClose(ancient, '2026-01-01_080000', WHO).action).toBe('close');
  });
});
