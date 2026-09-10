/**
 * Event-gated production AFR + washout window + governed event contract.
 * GATED in production; proven correct here. Synthetic identities only.
 */
import { AFR_V2_POLICY } from '../afr/afrV2Policy';
import { localDayStartMs, buildWashoutWindows, activeWashoutEvents, type WashoutEvent } from '../afr/washoutWindow';
import { computeAfrEventGated } from '../afr/afrEventGated';
import { computeAfrV1FromRates } from '../afr/afrV1';
import {
  validateAndBuildWellEvent, reconcileWellEventIdempotency, wellEventPayloadDigest,
  decideVoidWellEvent, isWellEventActive, resolveTimeZoneForState,
  type WellEventInput, type WellEventRecord,
} from '../afr/wellEventContract';
import type { AfrInterval } from '../afr/afrTypes';

const P = AFR_V2_POLICY;
const TZ = 'America/Chicago';
const DAY = 86400000;
const localYMD = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const localHM = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

let seq = 0;
const iv = (rate: number, over: Partial<AfrInterval> = {}): AfrInterval => {
  seq += 1;
  return { key: `k${seq}`, timestamp: Date.parse('2026-08-01T12:00:00Z') + seq * DAY, flowRateDays: rate, intervalMs: DAY, ...over };
};
const ivsAt = (rates: number[], startMs: number) =>
  rates.map((r, i) => ({ key: `k${i}`, timestamp: startMs + i * DAY, flowRateDays: r, intervalMs: DAY } as AfrInterval));

describe('EVENT-GATED production AFR — v1 unless an active washout window', () => {
  it('NO event → afr is v1 byte-identical and ON is not consumed', () => {
    const rates = [0.5, 0.52, 0.49, 0.51, 0.5, 1.5, 0.5]; // includes a >=2x anomaly + change
    const r = computeAfrEventGated(ivsAt(rates, Date.parse('2026-08-01T12:00:00Z')), P, {
      eventWindows: [], qualifiedOnDaysPerFoot: 0.9,
    });
    expect(r.mode).toBe('v1');
    expect(r.afr).toBe(computeAfrV1FromRates(rates)); // generic anomaly does NOT switch to v2
    expect(r.effectiveForecast).toBe(r.afr);          // ON ignored outside a window
  });

  it('Days 0/1/2/3/4 — washout day normal (v1), Days 1-3 recovery, Day 4 back to v1', () => {
    const occ = Date.parse('2026-08-10T18:00:00Z');
    const windows = buildWashoutWindows(
      [{ eventId: 'e1', companyId: 'c', wellKey: 'w', type: 'hot_oiler_washout', occurredAtUtc: occ }], TZ, P);
    const rates = [0.5, 0.5, 0.5, 0.5, 0.5, 2.0, 2.0]; // disturbed tail
    const at = (dayOffset: number) => localDayStartMs(occ, TZ) + dayOffset * DAY + 12 * 3600000;
    const call = (nowMs: number) => computeAfrEventGated(ivsAt(rates, occ - 5 * DAY), P, { eventWindows: windows, nowMs });
    expect(call(at(0)).mode).toBe('v1');             // washout day itself
    expect(call(at(1)).mode).toBe('washout_recovery');
    expect(call(at(1)).washoutDayIndex).toBe(1);
    expect(call(at(2)).washoutDayIndex).toBe(2);
    expect(call(at(3)).washoutDayIndex).toBe(3);
    expect(call(at(4)).mode).toBe('v1');             // recovery over → v1 forever after
  });

  it('inside a recovery window a qualified ON nudges the effective forecast (not the underlying afr)', () => {
    const occ = Date.parse('2026-08-10T18:00:00Z');
    const windows = buildWashoutWindows([{ eventId: 'e', companyId: 'c', wellKey: 'w', type: 'hot_oiler_washout', occurredAtUtc: occ }], TZ, P);
    const nowMs = localDayStartMs(occ, TZ) + 1 * DAY + 12 * 3600000; // Day 1
    const rates = [0.5, 0.5, 0.5, 0.5, 2.0, 2.0];
    const noOn = computeAfrEventGated(ivsAt(rates, occ - 4 * DAY), P, { eventWindows: windows, nowMs });
    const withOn = computeAfrEventGated(ivsAt(rates, occ - 4 * DAY), P, { eventWindows: windows, nowMs, qualifiedOnDaysPerFoot: 1.5 });
    expect(withOn.afr).toBe(noOn.afr);                      // underlying afr unchanged by ON
    expect(withOn.effectiveForecast).not.toBe(noOn.effectiveForecast); // ON only moves the effective
    expect(withOn.effectiveForecast).toBeGreaterThan(noOn.effectiveForecast);
  });
});

describe('washout windows — local days, DST, restart no-stacking', () => {
  const ev = (eventId: string, occurredAtUtc: number): WashoutEvent =>
    ({ eventId, companyId: 'c', wellKey: 'w', type: 'hot_oiler_washout', occurredAtUtc });

  it('localDayStartMs is local midnight; zone matters', () => {
    const ms = Date.parse('2026-08-24T04:36:37Z');
    expect(localHM(localDayStartMs(ms, TZ), TZ)).toBe('00:00');
    expect(localYMD(localDayStartMs(ms, TZ), TZ)).toBe('2026-08-23');
    expect(localYMD(localDayStartMs(ms, 'UTC'), 'UTC')).toBe('2026-08-24');
  });

  it('DST boundary: spring-forward week still yields 3 consecutive local days, each a local midnight', () => {
    const occ = Date.parse('2026-03-07T18:00:00Z'); // US DST begins 2026-03-08
    const w = buildWashoutWindows([ev('e', occ)], TZ, P);
    expect(w.length).toBe(3);
    for (const win of w) expect(localHM(win.startMs, TZ)).toBe('00:00');
    expect(w[0].endMs).toBe(w[1].startMs);
    expect(w[1].endMs).toBe(w[2].startMs);
  });

  it('one event → 3 days after the washout day (washout day excluded)', () => {
    const occ = Date.parse('2026-08-23T18:00:00Z');
    const w = buildWashoutWindows([ev('e', occ)], TZ, P);
    expect(w.map((x) => x.dayIndex)).toEqual([1, 2, 3]);
    expect(w.every((x) => localYMD(x.startMs, TZ) !== localYMD(localDayStartMs(occ, TZ), TZ))).toBe(true);
  });

  it('overlapping washouts restart with no stacked penalty (each local day owned once)', () => {
    const first = Date.parse('2026-08-23T18:00:00Z');
    const second = Date.parse('2026-08-25T18:00:00Z');
    const w = buildWashoutWindows([ev('e1', first), ev('e2', second)], TZ, P);
    expect(new Set(w.map((x) => x.startMs)).size).toBe(w.length); // no duplicate days
    expect(w.some((x) => localYMD(x.startMs, TZ) === '2026-08-26' && x.dayIndex === 1)).toBe(true); // newer event Day 1
  });
});

describe('event contract — governed, canonical ids, tz snapshot, idempotency', () => {
  const base: WellEventInput = {
    eventId: 'evt-01', companyId: 'liquid-gold', wellKey: 'gabriel-4',
    type: 'hot_oiler_washout', occurredAtUtc: Date.parse('2026-08-23T18:00:00Z'),
  };
  const ctx = { serverNowMs: Date.parse('2026-08-23T19:00:00Z'), timeZone: TZ, wellExists: true };
  const driver = { uid: 'driver-uuid', companyId: 'liquid-gold', isPlatformAdmin: false, role: 'driver' as const };

  it('unauthorized (no uid) and cross-company are rejected', () => {
    expect(validateAndBuildWellEvent(base, { uid: undefined }, ctx)).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(validateAndBuildWellEvent({ ...base, companyId: 'other' }, driver, ctx)).toMatchObject({ ok: false, code: 'permission-denied' });
  });
  it('the well key IS the wellName (spaces + API-number keys accepted; RTDB-forbidden chars rejected)', () => {
    // Proven identity: companyWells is keyed by wellName ("Gabriel 4"), so a
    // spaced key is valid; API-number keys are valid; . # / [ ] are RTDB-illegal.
    expect(validateAndBuildWellEvent({ ...base, wellKey: 'Gabriel 4' }, driver, ctx).ok).toBe(true);
    expect(validateAndBuildWellEvent({ ...base, wellKey: '33-053-04319-00-00' }, driver, ctx).ok).toBe(true);
    for (const bad of ['a/b', 'a.b', 'a#b', 'a[b]']) {
      expect(validateAndBuildWellEvent({ ...base, wellKey: bad }, driver, ctx)).toMatchObject({ ok: false, reason: 'well_key_malformed' });
    }
  });
  it('missing/invalid/future occurredAtUtc and unresolved timezone are rejected', () => {
    expect(validateAndBuildWellEvent({ ...base, occurredAtUtc: NaN }, driver, ctx)).toMatchObject({ ok: false });
    expect(validateAndBuildWellEvent({ ...base, occurredAtUtc: 0 }, driver, ctx)).toMatchObject({ ok: false, reason: 'occurred_at_missing_or_invalid' });
    expect(validateAndBuildWellEvent({ ...base, occurredAtUtc: ctx.serverNowMs + 5 * DAY }, driver, ctx)).toMatchObject({ ok: false, reason: 'occurred_at_in_future' });
    expect(validateAndBuildWellEvent(base, driver, { ...ctx, timeZone: 'Chicago' })).toMatchObject({ ok: false, reason: 'timezone_unresolved' });
  });
  it('well must exist in the company', () => {
    expect(validateAndBuildWellEvent(base, driver, { ...ctx, wellExists: false })).toMatchObject({ ok: false, code: 'not-found' });
  });
  it('a field driver (not a manager) may record for their own company; tz snapshot + role persisted', () => {
    const d = validateAndBuildWellEvent({ ...base, freshWaterBbls: 100, saltWaterBbls: 30, note: 'hot oiler' }, driver, ctx);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.record.recordedBy).toBe('driver-uuid');
      expect(d.record.recordedByRole).toBe('driver');
      expect(d.record.ianaTimezoneSnapshot).toBe(TZ);
      expect(d.record.serverRecordedAtUtc).toBe(ctx.serverNowMs);
      expect(d.record.freshWaterBbls).toBe(100);
      expect(d.record.saltWaterBbls).toBe(30);
      expect(d.path).toBe('well_events/liquid-gold/gabriel-4/evt-01');
      expect(typeof d.record.payloadDigest).toBe('string');
    }
  });
  it('late/backdated event (occurred well before now) is accepted', () => {
    const d = validateAndBuildWellEvent({ ...base, occurredAtUtc: ctx.serverNowMs - 30 * DAY }, driver, ctx);
    expect(d.ok).toBe(true);
  });
  it('repeated eventId + identical payload = idempotent; different payload = conflict (never silent)', () => {
    const digest = wellEventPayloadDigest(base);
    expect(reconcileWellEventIdempotency(null, digest)).toEqual({ action: 'create' });
    expect(reconcileWellEventIdempotency({ payloadDigest: digest }, digest)).toEqual({ action: 'idempotent' });
    const conflictDigest = wellEventPayloadDigest({ ...base, occurredAtUtc: base.occurredAtUtc + DAY });
    expect(reconcileWellEventIdempotency({ payloadDigest: digest }, conflictDigest)).toMatchObject({ action: 'conflict' });
  });
});

describe('timezone resolver, void, and active-event filtering', () => {
  it('resolveTimeZoneForState maps company state → IANA (never a global hardcode); unknown → empty', () => {
    expect(resolveTimeZoneForState('ND')).toBe('America/Chicago'); // liquid-gold (state ND) fallback
    expect(resolveTimeZoneForState('MT')).toBe('America/Denver');
    expect(resolveTimeZoneForState('ZZ')).toBe('');               // unknown → fail closed
    expect(resolveTimeZoneForState(undefined)).toBe('');
  });

  const rec = (over: Partial<WellEventRecord> = {}): WellEventRecord => ({
    eventId: 'e', companyId: 'liquid-gold', wellKey: 'Gabriel 4', type: 'hot_oiler_washout',
    occurredAtUtc: Date.parse('2026-08-23T18:00:00Z'), serverRecordedAtUtc: 1, recordedBy: 'm1',
    recordedByRole: 'manager', ianaTimezoneSnapshot: 'America/Chicago', payloadDigest: 'd', schemaVersion: 1, ...over,
  });
  const mgr = { uid: 'm1', companyId: 'liquid-gold', isPlatformAdmin: false, role: 'manager' as const };

  it('void is manager-only, auditable overlay (original preserved), repeated void idempotent', () => {
    expect(decideVoidWellEvent(rec(), { uid: 'd', companyId: 'liquid-gold', role: 'driver' }, { serverNowMs: 2 }))
      .toMatchObject({ ok: false, code: 'permission-denied' });
    expect(decideVoidWellEvent(null, mgr, { serverNowMs: 2 })).toMatchObject({ ok: false, code: 'not-found' });
    expect(decideVoidWellEvent(rec(), { uid: 'x', companyId: 'other', role: 'manager' }, { serverNowMs: 2 }))
      .toMatchObject({ ok: false, code: 'permission-denied' });
    const v = decideVoidWellEvent(rec(), mgr, { serverNowMs: 2, reason: 'mistake' });
    expect(v).toMatchObject({ ok: true, action: 'void' });
    if (v.ok) {
      expect(v.record.voidedAtUtc).toBe(2);
      expect(v.record.voidedBy).toBe('m1');
      expect(v.record.occurredAtUtc).toBe(rec().occurredAtUtc); // original preserved
      // repeated void is idempotent (no re-void)
      expect(decideVoidWellEvent(v.record, mgr, { serverNowMs: 9 })).toMatchObject({ ok: true, action: 'already_voided' });
    }
  });

  it('a voided event never activates AFR (excluded by activeWashoutEvents)', () => {
    expect(isWellEventActive(rec())).toBe(true);
    expect(isWellEventActive(rec({ voidedAtUtc: 5 }))).toBe(false);
    const occ = Date.parse('2026-08-23T18:00:00Z');
    const evs: WashoutEvent[] = [
      { eventId: 'a', companyId: 'c', wellKey: 'w', type: 'hot_oiler_washout', occurredAtUtc: occ },
      { eventId: 'b', companyId: 'c', wellKey: 'w', type: 'hot_oiler_washout', occurredAtUtc: occ, voidedAtUtc: occ + 1 },
      { eventId: 'future', companyId: 'c', wellKey: 'w', type: 'hot_oiler_washout', occurredAtUtc: occ + 100 * DAY },
    ];
    const active = activeWashoutEvents(evs, occ + DAY); // future & voided excluded
    expect(active.map((e) => e.eventId)).toEqual(['a']);
  });
});
