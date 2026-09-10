/**
 * Washout event-aware pure calc (windows) + governed event contract validation.
 * GATED in production; proven correct here so it is ready when an event producer
 * exists. Synthetic identities only.
 */
import { AFR_V2_POLICY } from '../afr/afrV2Policy';
import { localDayStartMs, buildWashoutWindows, type WashoutEvent } from '../afr/washoutWindow';
import { validateAndBuildWellEvent, type WellEventInput } from '../afr/wellEventContract';

const P = AFR_V2_POLICY;
const TZ = 'America/Chicago';
const localHM = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const localYMD = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

describe('local calendar-day math (company timezone, never hardcoded)', () => {
  it('localDayStartMs returns local midnight in the given zone', () => {
    const ms = Date.parse('2026-08-24T04:36:37Z'); // = 2026-08-23 23:36 CDT
    const start = localDayStartMs(ms, TZ);
    expect(localHM(start, TZ)).toBe('00:00');
    expect(localYMD(start, TZ)).toBe('2026-08-23');
  });
  it('the same instant yields different local days in different zones', () => {
    const ms = Date.parse('2026-08-24T04:36:37Z');
    expect(localYMD(localDayStartMs(ms, 'America/Chicago'), 'America/Chicago')).toBe('2026-08-23');
    expect(localYMD(localDayStartMs(ms, 'UTC'), 'UTC')).toBe('2026-08-24');
  });
});

describe('buildWashoutWindows — Days 1-3, washout day excluded, restart no-stacking', () => {
  const ev = (eventId: string, occurredAtUtc: number): WashoutEvent =>
    ({ eventId, companyId: 'liquid-gold', wellId: 'gabriel-4', type: 'hot_oiler_washout', occurredAtUtc });

  it('one event → exactly 3 consecutive local days AFTER the washout day', () => {
    const occ = Date.parse('2026-08-23T18:00:00Z');
    const w = buildWashoutWindows([ev('e1', occ)], TZ, P);
    expect(w.length).toBe(3);
    expect(w.map((x) => x.dayIndex)).toEqual([1, 2, 3]);
    // Washout day itself is not covered.
    const washoutDay = localYMD(localDayStartMs(occ, TZ), TZ);
    expect(w.every((x) => localYMD(x.startMs, TZ) !== washoutDay)).toBe(true);
    // Consecutive local days: each window's end is the next window's start.
    expect(w[0].endMs).toBe(w[1].startMs);
    expect(w[1].endMs).toBe(w[2].startMs);
  });

  it('a newer washout during the window restarts it — no day is penalized twice', () => {
    const first = Date.parse('2026-08-23T18:00:00Z');
    const second = Date.parse('2026-08-25T18:00:00Z'); // during first event's Day 2
    const w = buildWashoutWindows([ev('e1', first), ev('e2', second)], TZ, P);
    // No duplicate day windows (no stacked penalty on any local day).
    const starts = w.map((x) => x.startMs);
    expect(new Set(starts).size).toBe(starts.length);
    // Day 1 of the NEWER event is the local day after its washout day.
    expect(localYMD(localDayStartMs(second, TZ), TZ)).toBe('2026-08-25'); // second's washout day
    expect(w.some((x) => localYMD(x.startMs, TZ) === '2026-08-26' && x.dayIndex === 1)).toBe(true);
  });
});

describe('recordWellEvent contract — governed, canonical ids, idempotent', () => {
  const base: WellEventInput = {
    eventId: 'evt-2026-08-23-01', companyId: 'liquid-gold', wellId: 'gabriel-4',
    type: 'hot_oiler_washout', occurredAtUtc: Date.parse('2026-08-23T18:00:00Z'),
  };
  const caller = { uid: 'u1', companyId: 'liquid-gold', isPlatformAdmin: false };
  const NOW = Date.parse('2026-08-23T19:00:00Z');

  it('rejects unauthenticated callers', () => {
    const d = validateAndBuildWellEvent(base, { uid: undefined }, NOW);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe('unauthenticated');
  });
  it('rejects a display wellName (spaced) as the identity — must be canonical wellId', () => {
    const d = validateAndBuildWellEvent({ ...base, wellId: 'Gabriel 4' }, caller, NOW);
    expect(d.ok).toBe(false);
    if (!d.ok) { expect(d.code).toBe('invalid-argument'); expect(d.reason).toContain('well_id'); }
  });
  it('rejects a caller acting outside their company (no cross-company)', () => {
    const d = validateAndBuildWellEvent({ ...base, companyId: 'other-co' }, caller, NOW);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe('permission-denied');
  });
  it('rejects unsupported type, future / invalid occurredAt, negative volumes', () => {
    expect(validateAndBuildWellEvent({ ...base, type: 'x' as never }, caller, NOW).ok).toBe(false);
    expect(validateAndBuildWellEvent({ ...base, occurredAtUtc: NOW + 5 * 86400000 }, caller, NOW).ok).toBe(false);
    expect(validateAndBuildWellEvent({ ...base, freshBbls: -1 }, caller, NOW).ok).toBe(false);
  });
  it('accepts a valid event, stamps server time + recorder, keys the path by eventId', () => {
    const d = validateAndBuildWellEvent({ ...base, freshBbls: 100, saltBbls: 30, note: 'hot oiler' }, caller, NOW);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.record.serverRecordedAtUtc).toBe(NOW);
      expect(d.record.recordedBy).toBe('u1');
      expect(d.record.schemaVersion).toBe(1);
      expect(d.record.freshBbls).toBe(100);
      expect(d.record.saltBbls).toBe(30);
      expect(d.path).toBe('well_events/liquid-gold/gabriel-4/evt-2026-08-23-01'); // idempotency key
      expect(d.record.occurredAtUtc).toBe(base.occurredAtUtc); // operational moment preserved
    }
  });
  it('a platform admin may record for any company', () => {
    const d = validateAndBuildWellEvent({ ...base, companyId: 'other-co' }, { uid: 'p1', isPlatformAdmin: true }, NOW);
    expect(d.ok).toBe(true);
  });
});
