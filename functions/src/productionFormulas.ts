// productionFormulas.ts — pure production/date-bucketing billing formulas,
// extracted VERBATIM from index.ts (these were already calculation-only; the
// persistence lives in writeProductionLog). index.ts imports these; the full
// suite proves parity and golden-fixture tests pin the exact outputs. The
// 6am-6am window boundary, CST/CDT DST rule, date bucketing, recovery/flow math,
// and rounding are preserved exactly.

export interface HistoricalPull {
  key: string;
  timestamp: number;
  tankLevelFeet: number;
  bblsTaken: number;
  wellDown: boolean;
}

/** America/Chicago UTC offset (ms) at a timestamp — second-Sunday-March to
 *  first-Sunday-November is CDT (−5h), otherwise CST (−6h). */
export function getCSTOffset(timestampMs: number): number {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchSecondSun = new Date(Date.UTC(year, 2, 8 + (7 - marchFirst.getUTCDay()) % 7, 8));
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstSun = new Date(Date.UTC(year, 10, 1 + (7 - novFirst.getUTCDay()) % 7, 7));
  if (timestampMs >= marchSecondSun.getTime() && timestampMs < novFirstSun.getTime()) {
    return -5 * 60 * 60 * 1000; // CDT
  }
  return -6 * 60 * 60 * 1000; // CST
}

/** 6am-6am window end (ms) for a timestamp. Before 6am local → 6am same day;
 *  6am or after → 6am next day. */
export function getWindowEnd(timestampMs: number): number {
  const cstOffset = getCSTOffset(timestampMs);
  const localMs = timestampMs + cstOffset;
  const localDate = new Date(localMs);
  const hour = localDate.getUTCHours();
  const sixAmLocal = new Date(localDate);
  sixAmLocal.setUTCHours(6, 0, 0, 0);
  const sixAmUtc = sixAmLocal.getTime() - cstOffset;
  return hour < 6 ? sixAmUtc : sixAmUtc + 24 * 60 * 60 * 1000;
}

/** Production date (yyyy-mm-dd) for a timestamp using the 6am boundary. */
export function getProductionDate(timestampMs: number): string {
  const cstOffset = getCSTOffset(timestampMs);
  const localMs = timestampMs + cstOffset;
  const d = new Date(localMs);
  if (d.getUTCHours() < 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Window-averaged bbls/day: group flow rates by 6am-6am window, average the
 *  current window (fall back to the previous). */
export function calculateWindowBblsPerDay(historicalPulls: HistoricalPull[], bblPerFoot: number, pullTimestamp: number): number {
  if (!historicalPulls || historicalPulls.length < 2) return 0;

  const currentWindowEnd = getWindowEnd(pullTimestamp);
  const windowFlowRates = new Map<number, number[]>();

  for (let i = 1; i < historicalPulls.length; i++) {
    const current = historicalPulls[i];
    const previous = historicalPulls[i - 1];
    if (current.wellDown || previous.wellDown) continue;

    const timeDifDays = (current.timestamp - previous.timestamp) / (1000 * 60 * 60 * 24);
    if (timeDifDays <= 0) continue;

    const prevBottomFeet = Math.max(previous.tankLevelFeet - (previous.bblsTaken / bblPerFoot), 0);
    const recoveryFeet = current.tankLevelFeet - prevBottomFeet;
    if (recoveryFeet <= 0) continue;

    const flowRateDays = timeDifDays / recoveryFeet;
    if (flowRateDays <= 0 || flowRateDays >= 365) continue;

    const windowEnd = getWindowEnd(current.timestamp);
    const existing = windowFlowRates.get(windowEnd) || [];
    existing.push(flowRateDays);
    windowFlowRates.set(windowEnd, existing);
  }

  let flowRates = windowFlowRates.get(currentWindowEnd);
  if (!flowRates || flowRates.length === 0) {
    const prevWindowEnd = currentWindowEnd - 24 * 60 * 60 * 1000;
    flowRates = windowFlowRates.get(prevWindowEnd);
  }
  if (!flowRates || flowRates.length === 0) return 0;

  const avgFlowRateDays = flowRates.reduce((a, b) => a + b, 0) / flowRates.length;
  if (avgFlowRateDays <= 0) return 0;

  return Math.round((1 / avgFlowRateDays) * bblPerFoot);
}

/** Overnight/longest-gap bbls/day: most recent previous-day pull → first pull today. */
export function calculateOvernightBblsPerDay(historicalPulls: HistoricalPull[], bblPerFoot: number, pullTimestamp: number): number {
  if (!historicalPulls || historicalPulls.length < 2) return 0;

  const todayDate = new Date(pullTimestamp).toISOString().slice(0, 10);

  let firstPullToday: HistoricalPull | null = null;
  let lastPullPrevDay: HistoricalPull | null = null;

  for (let i = historicalPulls.length - 1; i >= 0; i--) {
    const pull = historicalPulls[i];
    const pullDate = new Date(pull.timestamp).toISOString().slice(0, 10);

    if (pullDate === todayDate) {
      firstPullToday = pull;
    } else {
      lastPullPrevDay = pull;
      break;
    }
  }

  if (!firstPullToday || !lastPullPrevDay) return 0;
  if (firstPullToday.wellDown || lastPullPrevDay.wellDown) return 0;

  const timeDifDays = (firstPullToday.timestamp - lastPullPrevDay.timestamp) / (1000 * 60 * 60 * 24);
  if (timeDifDays <= 0) return 0;

  const prevBottomFeet = Math.max(lastPullPrevDay.tankLevelFeet - (lastPullPrevDay.bblsTaken / bblPerFoot), 0);
  const recoveryFeet = firstPullToday.tankLevelFeet - prevBottomFeet;
  if (recoveryFeet <= 0) return 0;

  const flowRateDays = timeDifDays / recoveryFeet;
  return Math.round((1 / flowRateDays) * bblPerFoot);
}

/** Outgoing 24hr bbls at a given AFR (days/ft): (1/afr)*20*tanks, rounded. */
export function computeBbls24hrs(afr: number, tanks: number): string {
  if (!(afr > 0)) return '0';
  return Math.round((1 / afr) * 20 * tanks).toString();
}
