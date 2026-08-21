/**
 * Production tank / flow / ETA domain used by submitFieldCommand.
 * Ported from Dashboard processIncomingPull helpers so the secure path
 * does not invent placeholder math.
 */
export interface HistoricalPull {
  key: string;
  timestamp: number;
  tankLevelFeet: number;
  bblsTaken: number;
  wellDown: boolean;
}

export function resolveBblPerFoot(config: Record<string, unknown>): number {
  const stored = Number(config.bblPerFoot);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const tanks = Number(config.tanks || config.numTanks || 1) || 1;
  return 20 * tanks;
}

export function inchesToFeetInches(inches: number): string {
  const safe = Number.isFinite(inches) ? Math.max(0, inches) : 0;
  const feet = Math.floor(safe / 12);
  const remainingInches = Math.floor(safe % 12);
  return `${feet}'${remainingInches}"`;
}

export function daysToHMM(days: number): string {
  const totalMinutes = Math.floor(days * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}`;
}

export function daysToHMMSS(days: number): string {
  const totalSeconds = Math.floor(days * 24 * 60 * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function computeTankLevels(input: {
  tankLevelFeet: number;
  bblsTaken: number;
  bblPerFoot: number;
}): { tankTopInches: number; tankAfterInches: number } {
  const tankTopInches = (Number(input.tankLevelFeet) || 0) * 12;
  const bblsInInches = input.bblsTaken > 0 && input.bblPerFoot > 0
    ? (input.bblsTaken / input.bblPerFoot) * 12
    : 0;
  return { tankTopInches, tankAfterInches: tankTopInches - bblsInInches };
}

export function calculateWindowBblsPerDay(
  historicalPulls: HistoricalPull[],
  bblPerFoot: number,
  pullTimestamp: number,
): number {
  if (!historicalPulls || historicalPulls.length < 2) return 0;
  const currentWindowEnd = getWindowEnd(pullTimestamp);
  const windowFlowRates = new Map<number, number[]>();
  for (let i = 1; i < historicalPulls.length; i++) {
    const current = historicalPulls[i];
    const previous = historicalPulls[i - 1];
    if (current.wellDown || previous.wellDown) continue;
    const timeDifDays = (current.timestamp - previous.timestamp) / (1000 * 60 * 60 * 24);
    if (timeDifDays <= 0) continue;
    const prevBottomFeet = Math.max(previous.tankLevelFeet - previous.bblsTaken / bblPerFoot, 0);
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
    flowRates = windowFlowRates.get(currentWindowEnd - 24 * 60 * 60 * 1000);
  }
  if (!flowRates || flowRates.length === 0) return 0;
  const avg = flowRates.reduce((a, b) => a + b, 0) / flowRates.length;
  if (avg <= 0) return 0;
  return Math.round((1 / avg) * bblPerFoot);
}

export function estimatePull(input: {
  tankAfterInches: number;
  bottomInches: number;
  pullBbls: number;
  tanks: number;
  afrDays: number;
  dateTimeUTC: string;
  wellDown: boolean;
  bblPerFoot: number;
}): { timeTillPull: string; nextPullTimeUTC: string | null; flowRate: string; bbls24hrs: string } {
  if (input.wellDown) {
    return { timeTillPull: 'Down', nextPullTimeUTC: null, flowRate: 'Unknown', bbls24hrs: '0' };
  }
  const bpf = Number(input.bblPerFoot) > 0 ? Number(input.bblPerFoot) : 20 * (Number(input.tanks) || 1);
  const pullHeightInches = bpf > 0 ? (input.pullBbls / bpf) * 12 : 0;
  const target = input.bottomInches + pullHeightInches;
  const recoveryNeeded = Math.max(0, target - input.tankAfterInches);
  let estTimeToPull = '';
  let estDateTimePull = '';
  if (input.afrDays > 0 && recoveryNeeded > 0) {
    const estDays = (recoveryNeeded / 12) * input.afrDays;
    estTimeToPull = daysToHMM(estDays);
    const pullDate = new Date(input.dateTimeUTC);
    estDateTimePull = new Date(pullDate.getTime() + estDays * 24 * 60 * 60 * 1000).toISOString();
  } else if (recoveryNeeded === 0) {
    estTimeToPull = '0:00';
    estDateTimePull = input.dateTimeUTC;
  }
  let bbls24hrs = '0';
  if (input.afrDays > 0) {
    bbls24hrs = String(Math.round((1 / input.afrDays) * bpf));
  }
  return {
    timeTillPull: estTimeToPull || '0:00',
    nextPullTimeUTC: estDateTimePull || null,
    flowRate: input.afrDays > 0 ? daysToHMMSS(input.afrDays) : 'Unknown',
    bbls24hrs,
  };
}

function getCSTOffset(timestampMs: number): number {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchSecondSun = new Date(Date.UTC(year, 2, 8 + ((7 - marchFirst.getUTCDay()) % 7), 8));
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstSun = new Date(Date.UTC(year, 10, 1 + ((7 - novFirst.getUTCDay()) % 7), 7));
  if (timestampMs >= marchSecondSun.getTime() && timestampMs < novFirstSun.getTime()) {
    return -5 * 60 * 60 * 1000;
  }
  return -6 * 60 * 60 * 1000;
}

function getWindowEnd(timestampMs: number): number {
  const cstOffset = getCSTOffset(timestampMs);
  const localMs = timestampMs + cstOffset;
  const localDate = new Date(localMs);
  const hour = localDate.getUTCHours();
  const sixAmLocal = new Date(localDate);
  sixAmLocal.setUTCHours(6, 0, 0, 0);
  const sixAmUtc = sixAmLocal.getTime() - cstOffset;
  return hour < 6 ? sixAmUtc : sixAmUtc + 24 * 60 * 60 * 1000;
}

export function afrDaysFromHistory(
  historicalPulls: HistoricalPull[],
  bblPerFoot: number,
  pullTimestamp: number,
): number {
  const bbls = calculateWindowBblsPerDay(historicalPulls, bblPerFoot, pullTimestamp);
  if (bbls <= 0 || bblPerFoot <= 0) return 0;
  return bblPerFoot / bbls;
}
