/**
 * Event-aware pure calculation for washout recovery windows. GATED at the call
 * site (no explicit event producer in production yet), but implemented and
 * tested so it is correct the moment an event source exists.
 *
 * Rules (final washout correction):
 *   - The washout DAY ITSELF is normal (never modified).
 *   - The next `recoveryDays` LOCAL calendar days (in the company IANA timezone —
 *     never a hardcoded zone) get reduced-confidence windows, Day 1/2/3.
 *   - A NEWER washout during an active window RESTARTS Days 1-3 from the newer
 *     event; penalties never stack (each local day is covered by at most one
 *     window, owned by the latest applicable event).
 */
import type { EventWindow } from './afrV2';
import type { AfrV2Policy } from './afrV2Policy';

export interface WashoutEvent {
  eventId: string;
  companyId: string;
  wellKey: string;        // the well's key = its wellName (no separate wellId)
  type: 'hot_oiler_washout';
  occurredAtUtc: number;  // ms epoch
  voidedAtUtc?: number;   // set when the event was voided (never activates AFR)
}

/**
 * Active washout events for a forecast at `asOfMs`: not voided, and occurring
 * strictly before the observation. A FUTURE event can never affect a past
 * forecast (windows are always after their event, but this also excludes an
 * event recorded with occurredAtUtc after the observation being computed).
 */
export function activeWashoutEvents(events: WashoutEvent[], asOfMs: number): WashoutEvent[] {
  return (events || []).filter((e) => !e.voidedAtUtc && Number.isFinite(e.occurredAtUtc) && e.occurredAtUtc <= asOfMs);
}

/** Wall-clock offset (localWall - UTC) in ms for `ms` in `timeZone`. */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '0' : p.hour), +p.minute, +p.second);
  return asUTC - ms;
}

/** UTC ms of local midnight for the local calendar day containing `ms`. */
export function localDayStartMs(ms: number, timeZone: string): number {
  const off = tzOffsetMs(ms, timeZone);
  const localMidnightWall = Math.floor((ms + off) / 86400000) * 86400000;
  let utc = localMidnightWall - off;
  const off2 = tzOffsetMs(utc, timeZone); // refine across a DST edge
  if (off2 !== off) utc = localMidnightWall - off2;
  return utc;
}

/** Start of the local day `n` local days after the day containing `ms`. */
function localDayStartPlus(ms: number, timeZone: string, n: number): number {
  // Land near noon of the target day to avoid DST edges, then snap to its start.
  const approx = localDayStartMs(ms, timeZone) + n * 86400000 + 12 * 3600000;
  return localDayStartMs(approx, timeZone);
}

/**
 * Build recovery windows for a set of washout events in one well/company tz.
 * Newer events restart the window; each local day is owned by at most one
 * (the latest) event → no stacked penalties.
 */
export function buildWashoutWindows(
  events: WashoutEvent[],
  timeZone: string,
  policy: AfrV2Policy,
): EventWindow[] {
  const recoveryDays = policy.washout.recoveryDays;
  // Latest event first, so an earlier event never overwrites a newer one's day.
  const sorted = [...events].sort((a, b) => b.occurredAtUtc - a.occurredAtUtc);
  const byDayStart = new Map<number, EventWindow>();
  for (const ev of sorted) {
    for (let d = 1; d <= recoveryDays; d++) {
      const startMs = localDayStartPlus(ev.occurredAtUtc, timeZone, d);
      if (byDayStart.has(startMs)) continue; // a newer event already owns this day
      const endMs = localDayStartPlus(startMs, timeZone, 1);
      byDayStart.set(startMs, { startMs, endMs, dayIndex: d });
    }
  }
  return [...byDayStart.values()].sort((a, b) => a.startMs - b.startMs);
}
