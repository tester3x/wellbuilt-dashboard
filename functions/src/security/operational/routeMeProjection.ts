/**
 * Pure Route Me live-level and TTP projection engine.
 *
 * Mandatory projection rule:
 * Route Me must NEVER consume frozen Level, Time Till Pull, or copied currentLevel.
 * At one immutable asOfMs, calculate strictly from:
 * 1. Raw post-pull baseline level (lastPullBottomLevel)
 * 2. Authoritative observation timestamp (lastPullDateTimeUTC / timestampUTC)
 * 3. Governed flow rate (avgFlowRate / flowRate "H:MM:SS" or minutes/foot)
 * 4. Trigger / ready level (allowedBottom + pullBbls / bblPerFoot)
 *
 * Invariants:
 * - projected level rises with elapsed time
 * - remaining TTP falls by the same elapsed time
 * - predicted Next Pull (predictedReadyAtMs) remains fixed
 * - repeated projection never compounds (anchored strictly to immutable raw baseline)
 * - DOWN wells remain frozen at baseline
 * - missing baseline/time fails unavailable ('--', 'Unknown'), never zero
 */

export const MAX_LEVEL_FEET = 20;
export const MIN_LEVEL_FEET = 0;
export const MIN_VALID_PULL_MS = Date.UTC(2020, 0, 1);

export interface RouteMeProjectionInputs {
  /** Raw post-pull baseline level in decimal feet (from lastPullBottomLevel). */
  startingBottomFeet: number | null;
  /** Authoritative pull observation timestamp in epoch ms (from lastPullDateTimeUTC). */
  pullTimeMs: number | null;
  /** Governed flow rate in minutes per foot of rise (from flowRate "H:MM:SS" or avgFlowRateMinutes). */
  flowMinutesPerFoot: number | null;
  /** True if well is flagged down/offline. */
  wellDown: boolean;
  /** Trigger / pull-ready height in decimal feet (from allowedBottom + pullBbls / bblPerFoot). */
  targetFeet: number | null;
}

export interface RouteMeProjectionResult {
  /** WB-M formatted display string (e.g. "7'1\"", "4'9\"", "10'"), or '--' if unavailable. */
  levelDisplay: string;
  /** Formatted remaining time until pull (e.g. "17h 32m", "9h 32m", "Ready", "Down", "Unknown"). */
  timeTillPull: string;
  /** Priority state for Route Me ordering & visual badge. */
  priorityState: 'pull-now' | 'approaching' | 'verify' | 'down' | 'no-gain';
  /** Fixed absolute predicted ready time in epoch ms, or null if cannot be forecast. */
  predictedReadyAtMs: number | null;
  /** Projected level in decimal feet at asOfMs. */
  projectedFeet: number | null;
  /** Remaining minutes until pull ready at asOfMs, or null. */
  remainingMinutes: number | null;
  /** True if a valid positive flow rate drove a dynamic rise. */
  hasFlow: boolean;
  /** True if level is frozen at baseline (no flow or well down). */
  frozen: boolean;
  /** False when baseline or timestamp is missing (unavailable, never fabricated as 0). */
  available: boolean;
}

/**
 * Parse level string to decimal feet.
 * Handles "4'9\"", "10'0\"", "5'", "18'6\"", "7'6", bare numbers, etc.
 */
export function parseFeetDecimal(str: unknown): number | null {
  if (str == null) return null;
  if (typeof str === 'number') {
    return Number.isFinite(str) && str >= 0 ? str : null;
  }
  const s = String(str).trim();
  if (!s || s === '--' || s.toUpperCase() === 'DOWN') return null;
  const fi = s.match(/^(\d+)\s*'\s*(\d+)?\s*"?$/);
  if (fi) {
    const feet = parseInt(fi[1], 10);
    const inches = fi[2] ? parseInt(fi[2], 10) : 0;
    return feet + inches / 12;
  }
  const n = parseFloat(s.replace(/["']/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse flow rate ("H:MM:SS" or "H:MM" or numeric minutes) into minutes per foot.
 * Example: "3:20:24" = 3*60 + 20 + 24/60 = 200.4 minutes/foot.
 */
export function parseFlowMinutesPerFoot(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 1 ? raw : null;
  }
  const s = String(raw).trim();
  if (!s || s === '--' || s.toLowerCase() === 'unknown') return null;

  // H:MM:SS format
  const m3 = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (m3) {
    const hours = parseInt(m3[1], 10);
    const mins = parseInt(m3[2], 10);
    const secs = parseInt(m3[3], 10);
    const totalMinutes = hours * 60 + mins + secs / 60;
    return Number.isFinite(totalMinutes) && totalMinutes >= 1 ? totalMinutes : null;
  }

  // H:MM format
  const m2 = s.match(/^(\d+):(\d{1,2})$/);
  if (m2) {
    const hours = parseInt(m2[1], 10);
    const mins = parseInt(m2[2], 10);
    const totalMinutes = hours * 60 + mins;
    return Number.isFinite(totalMinutes) && totalMinutes >= 1 ? totalMinutes : null;
  }

  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Format decimal feet to standard whole-inch display string.
 * Uses WB-M inch flooring: floor(feet * 12 + 0.0001), omits zero inches ("7'" not "7'0\"").
 */
export function formatFeetWBM(feet: number | null): string {
  if (feet == null || !Number.isFinite(feet)) return '--';
  const clamped = Math.max(MIN_LEVEL_FEET, Math.min(feet, MAX_LEVEL_FEET));
  const totalInches = Math.floor(clamped * 12 + 0.0001);
  const ft = Math.floor(totalInches / 12);
  const inch = totalInches - ft * 12;
  return inch === 0 ? `${ft}'` : `${ft}'${inch}"`;
}

/**
 * Format remaining minutes into human-readable TTP string ("17h 32m", "9h 32m", "1d 3h 15m", "Ready").
 */
export function formatTtp(remainingMinutes: number | null): string {
  if (remainingMinutes == null || !Number.isFinite(remainingMinutes)) return 'Unknown';
  if (remainingMinutes <= 0) return 'Ready';
  const totalMins = Math.floor(remainingMinutes);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  return `${hours}h ${mins}m`;
}

/**
 * Parse an ISO date or timestamp string into epoch milliseconds.
 * Rejects pre-2020 timestamps.
 */
export function parsePullTimeMs(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= MIN_VALID_PULL_MS ? raw : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) && parsed >= MIN_VALID_PULL_MS ? parsed : null;
}

/**
 * Calculate trigger / pull-ready height in decimal feet.
 * targetFeet = allowedBottomFeet + pullBbls / bblPerFoot
 */
export function calculateTargetFeet(args: {
  allowedBottomFeet: number | null;
  pullBbls: number | null;
  bblPerFoot: number | null;
}): number | null {
  const { allowedBottomFeet, pullBbls, bblPerFoot } = args;
  if (allowedBottomFeet == null || allowedBottomFeet < 0) return null;
  if (pullBbls == null || pullBbls <= 0) return null;
  if (bblPerFoot == null || bblPerFoot <= 0) return null;
  return allowedBottomFeet + pullBbls / bblPerFoot;
}

/**
 * Calculate dynamic live level and TTP projection at a single immutable asOfMs.
 */
export function projectRouteMeLevelAndTtp(
  inputs: RouteMeProjectionInputs,
  asOfMs: number,
): RouteMeProjectionResult {
  // 1. DOWN wells remain frozen at baseline level; TTP is 'Down'.
  if (inputs.wellDown) {
    const baseFeet = inputs.startingBottomFeet != null ? Math.min(inputs.startingBottomFeet, MAX_LEVEL_FEET) : null;
    return {
      levelDisplay: formatFeetWBM(baseFeet),
      timeTillPull: 'Down',
      priorityState: 'down',
      predictedReadyAtMs: null,
      projectedFeet: baseFeet,
      remainingMinutes: null,
      hasFlow: false,
      frozen: true,
      available: baseFeet != null,
    };
  }

  // 2. Missing baseline or observation timestamp: fails unavailable, NEVER zero.
  if (inputs.startingBottomFeet == null || inputs.pullTimeMs == null) {
    return {
      levelDisplay: '--',
      timeTillPull: 'Unknown',
      priorityState: 'verify',
      predictedReadyAtMs: null,
      projectedFeet: null,
      remainingMinutes: null,
      hasFlow: false,
      frozen: false,
      available: false,
    };
  }

  // 3. Missing or invalid flow rate (< 1 min/ft): level remains frozen at baseline, cannot forecast TTP.
  if (inputs.flowMinutesPerFoot == null || inputs.flowMinutesPerFoot < 1) {
    const baseFeet = Math.min(inputs.startingBottomFeet, MAX_LEVEL_FEET);
    return {
      levelDisplay: formatFeetWBM(baseFeet),
      timeTillPull: 'Unknown',
      priorityState: 'no-gain',
      predictedReadyAtMs: null,
      projectedFeet: baseFeet,
      remainingMinutes: null,
      hasFlow: false,
      frozen: true,
      available: true,
    };
  }

  // 4. Governed dynamic projection:
  // Elapsed time strictly from immutable observation timestamp to asOfMs
  const minutesSincePull = Math.max(0, (asOfMs - inputs.pullTimeMs) / 60000);
  const riseFeet = minutesSincePull / inputs.flowMinutesPerFoot;
  const rawProjected = inputs.startingBottomFeet + riseFeet;
  const projectedFeet = Math.max(MIN_LEVEL_FEET, Math.min(rawProjected, MAX_LEVEL_FEET));
  const levelDisplay = formatFeetWBM(projectedFeet);

  // Missing target / trigger height: level rises but TTP cannot be forecast
  if (inputs.targetFeet == null) {
    return {
      levelDisplay,
      timeTillPull: 'Unknown',
      priorityState: 'verify',
      predictedReadyAtMs: null,
      projectedFeet,
      remainingMinutes: null,
      hasFlow: true,
      frozen: false,
      available: true,
    };
  }

  // Next pull prediction:
  // Total fill duration = (targetFeet - startingBottomFeet) * flowMinutesPerFoot
  // predictedReadyAtMs = pullTimeMs + fillDurationMs (FIXED invariant!)
  const feetToGo = inputs.targetFeet - inputs.startingBottomFeet;
  const fullFillMinutes = feetToGo > 0 ? feetToGo * inputs.flowMinutesPerFoot : 0;
  const predictedReadyAtMs = Math.round(inputs.pullTimeMs + fullFillMinutes * 60000);

  // Remaining TTP:
  // remainingMinutes = (predictedReadyAtMs - asOfMs) / 60000 (falls by elapsed time!)
  const remainingMinutes = (predictedReadyAtMs - asOfMs) / 60000;
  const timeTillPull = formatTtp(remainingMinutes);

  // Priority state:
  let priorityState: RouteMeProjectionResult['priorityState'];
  if (remainingMinutes <= 0 || projectedFeet >= inputs.targetFeet) {
    priorityState = 'pull-now';
  } else if (remainingMinutes <= 240) {
    // Within 4 hours of ready
    priorityState = 'approaching';
  } else {
    priorityState = 'verify';
  }

  return {
    levelDisplay,
    timeTillPull,
    priorityState,
    predictedReadyAtMs,
    projectedFeet,
    remainingMinutes,
    hasFlow: true,
    frozen: false,
    available: true,
  };
}
