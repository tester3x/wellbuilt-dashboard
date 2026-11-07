import {isProvisionalPull} from './watchdog/barrelDecision';

const ANOMALY_RATIO = 2.0;     // 2x off median = excluded from AFR averaging
const ITREVIEW_RATIO = 1.5;    // 1.5x off median = flagged but included in AFR
const DAY_MS = 86_400_000;
const MAX_RECOVERY_DAYS = 3;
const MAX_STRIKE_SPAN_MS = 3 * DAY_MS;
const MIN_RECOVERY_INCHES = 3;
const MAX_STRIKE_RATE_RATIO = 2;
const REGIME_SHIFT_THRESHOLD = 3;

interface RateSample {
  rate: number;
  at: number;
  sequence: number;
  strikeEligible: boolean;
}

interface FlowObservation {
  packetId?: string;
  requestType?: string;
  dateTimeUTC?: string;
  gaugeTime?: string;
  dateTime?: string;
  deleted?: boolean;
  noLevel?: boolean;
  wellDown?: boolean | string;
  afrWellDown?: boolean;
  flowIntervalBarrier?: boolean;
  flowRateDays?: number;
  timeDifDays?: number;
  recoveryInches?: number;
}

export function recentFlowSamples(history: Record<string, FlowObservation>, asOf = Infinity): RateSample[] {
  const observations = Object.entries(history)
    .filter(([id, row]) => !row.deleted && (!row.requestType || row.requestType === 'pull') &&
      !/^(edit_|delete_|history_)/.test(id))
    .map(([id, row]) => ({id, row, at: Date.parse(row.dateTimeUTC || row.gaugeTime || row.dateTime || '') || 0}))
    .filter(({at}) => at <= asOf)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const samples: RateSample[] = [];
  let downSince: number | undefined;
  let settlingUntil = 0;
  let previousAt = 0;
  let previousUnusable = false;
  let sequence = 0;

  for (const {id, row, at} of observations) {
    const identity = row.packetId || id;
    if (seen.has(identity)) continue;
    seen.add(identity);
    sequence++;
    const priorAt = previousAt;
    const priorUnusable = previousUnusable;
    previousAt = at;
    previousUnusable = !!(row.noLevel || row.flowIntervalBarrier || isProvisionalPull(row));
    const down = row.afrWellDown ?? row.wellDown;
    if (at && (down === true || down === 'true')) {
      downSince ??= at;
      continue;
    }
    if (downSince !== undefined) {
      if (!at || (down !== false && down !== 'false') || previousUnusable) continue;
      const daysToSettle = at - downSince >= DAY_MS ? 2 : 1;
      settlingUntil = at + daysToSettle * DAY_MS;
      downSince = undefined;
      continue;
    }
    const rate = row.flowRateDays || 0;
    if (!Number.isFinite(rate) || rate <= 0 || rate >= 365 || previousUnusable || priorUnusable) continue;
    const observedDays = priorAt && at > priorAt ? (at - priorAt) / DAY_MS : 0;
    const elapsedDays = row.timeDifDays && row.timeDifDays > 0 ? row.timeDifDays : observedDays;
    const intervalStart = at - Math.max(elapsedDays, observedDays) * DAY_MS;
    const rise = row.recoveryInches ?? (elapsedDays > 0 ? elapsedDays * 12 / rate : undefined);
    if ((settlingUntil && intervalStart < settlingUntil) ||
        Math.max(elapsedDays, observedDays) > MAX_RECOVERY_DAYS ||
        (rise !== undefined && rise < MIN_RECOVERY_INCHES)) continue;
    // Older records without interval evidence can still contribute to smoothing.
    samples.push({rate, at, sequence, strikeEligible: at > 0 && elapsedDays > 0 &&
      rise !== undefined && Number.isFinite(rise)});
  }
  return samples.slice(-16);
}

function confirmsChange(samples: RateSample[], latest: RateSample): boolean {
  if (samples.length !== REGIME_SHIFT_THRESHOLD || samples.at(-1) !== latest) return false;
  if (samples.some((sample, index) => !sample.strikeEligible ||
      sample.sequence !== samples[0].sequence + index ||
      (index > 0 && sample.at <= samples[index - 1].at))) return false;
  const rates = samples.map(sample => sample.rate);
  return latest.at - samples[0].at <= MAX_STRIKE_SPAN_MS &&
    Math.max(...rates) / Math.min(...rates) <= MAX_STRIKE_RATE_RATIO;
}

// Calculate median of an array
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Determine anomaly level for a flow rate based on median (VBA two-tier system)
// Returns: 0 = Normal, 1 = IT Review (2.5x-5x), 2 = Anomaly (>5x, excluded from AFR)
function getFlowRateAnomalyLevel(flowRate: number, medianRate: number): number {
  if (medianRate <= 0 || flowRate <= 0) return 0;

  // Calculate ratio (how far off from median)
  const ratio = flowRate < medianRate
    ? medianRate / flowRate
    : flowRate / medianRate;

  if (ratio >= ANOMALY_RATIO) {
    return 2; // Anomaly - excluded from averaging
  } else if (ratio >= ITREVIEW_RATIO) {
    return 1; // IT Review - flagged but included
  }
  return 0; // Normal
}

// Filter out anomalies (2x+ off median) from flow rates.
// Uses two passes plus a regime-shift escape:
//   1. Progressive median — catches outliers as they appear, lets the well's
//      baseline drift over time (handles legitimate regime changes when paired
//      with step detection downstream).
//   1b. A new baseline needs three consecutive Tier-2 rejections in the same
//       direction, each with reliable recovery evidence and comparable rates.
//   2. Final pass with the OVERALL median of pass-1 results — catches early
//      outliers that were grandfathered in before there was enough baseline
//      data (matches the dashboard's anomaly badges so AFR and the UI agree).
// Returns rates with Tier 2 anomalies removed.
function filterAnomalies(flowRates: RateSample[]): RateSample[] {
  if (flowRates.length < 3) {
    return flowRates;
  }

  // Pass 1: progressive (also tracks rejection direction for regime-shift detection)
  const knownRates: number[] = [];
  const passOne: RateSample[] = [];
  // 0 = accepted, +1 = rejected as higher than baseline, -1 = rejected as lower
  const directions: number[] = [];
  for (const sample of flowRates) {
    const {rate} = sample;
    if (knownRates.length >= 3) {
      const medianRate = median(knownRates);
      const level = getFlowRateAnomalyLevel(rate, medianRate);
      if (level < 2) {
        passOne.push(sample);
        knownRates.push(rate);
        directions.push(0);
      } else {
        directions.push(rate > medianRate ? 1 : -1);
      }
    } else {
      // Not enough baseline yet — include for now; pass 2 will re-check.
      passOne.push(sample);
      knownRates.push(rate);
      directions.push(0);
    }
  }

  // Pass 1b: regime-shift escape. Scan tail for consecutive same-direction
  // Tier-2 rejections. If we find a run of REGIME_SHIFT_THRESHOLD or more,
  // use the latest three once they meet the confirmation checks.
  let runDir = 0;
  let runStart = -1;
  for (let i = directions.length - 1; i >= 0; i--) {
    const d = directions[i];
    if (d === 0) break;
    if (runDir === 0) runDir = d;
    if (d !== runDir) break;
    runStart = i;
  }
  const recent = flowRates.slice(-REGIME_SHIFT_THRESHOLD);
  if (runStart >= 0 && directions.length - runStart >= REGIME_SHIFT_THRESHOLD && confirmsChange(recent, flowRates.at(-1)!)) {
    console.log(`[AFR] regime shift confirmed: three consistent ${runDir > 0 ? 'slower' : 'faster'} readings`);
    return recent;
  }

  // Pass 2: re-check every kept rate against the OVERALL median.
  // This catches early packets that got grandfathered in during pass 1.
  if (passOne.length < 5) {
    return passOne; // Too few to safely re-filter
  }
  const overallMedian = median(knownRates);
  const filtered = passOne.filter(({rate}) => getFlowRateAnomalyLevel(rate, overallMedian) < 2);

  if (filtered.length < 3) {
    return passOne;
  }
  return filtered;
}

// Calculate AFR from recent flow rates using Exponential Moving Average (EMA).
// EMA tracks gradual well slowdowns better than a fixed-window rolling average.
// Alpha = 0.4 gives ~60% weight to recent pulls while smoothing noise.
const EMA_ALPHA = 0.4;

export function averageFlowRates(allRates: RateSample[], wellName = "flow"): number {
  if (allRates.length === 0) return 0;
  const last = allRates[allRates.length - 1];
  if (allRates.length < 3) return last.rate;

  console.log(`[AFR] ${wellName}: ${allRates.length} raw rates`);

  // Filter out anomalies (2x off progressive median) before calculating AFR
  const samples = filterAnomalies(allRates);
  const rates = samples.map(sample => sample.rate);

  console.log(`[AFR] ${wellName}: ${rates.length} after anomaly filter`);

  if (rates.length === 0) return last.rate;
  if (rates.length < 3) return rates[rates.length - 1];

  // Step detection: Check if last 3 are ALL >10% off in same direction
  // Catches sudden regime changes (e.g., well workover, pump change)
  const STEP_THRESHOLD = 0.10;
  if (rates.length >= 5 && confirmsChange(samples.slice(-3), last)) {
    const preStepRates = rates.slice(0, -3);
    const recentRates = rates.slice(-3);
    const preStepAvg = preStepRates.reduce((a, b) => a + b, 0) / preStepRates.length;

    let allHigher = true;
    let allLower = true;

    for (const rate of recentRates) {
      const deviation = (rate - preStepAvg) / preStepAvg;
      if (deviation <= STEP_THRESHOLD) allHigher = false;
      if (deviation >= -STEP_THRESHOLD) allLower = false;
    }

    if (allHigher || allLower) {
      // Step detected - use median of last 3 to reset quickly
      const sorted = [...recentRates].sort((a, b) => a - b);
      console.log(`[AFR] ${wellName}: STEP DETECTED, median of last 3: ${sorted[1].toFixed(6)}`);
      return sorted[1];
    }
  }

  // EMA: Exponential Moving Average (alpha=0.4)
  // Seed with the first rate, then apply EMA formula chronologically.
  // Recent pulls get exponentially more weight, tracking drift without lag.
  let ema = rates[0];
  for (let i = 1; i < rates.length; i++) {
    ema = EMA_ALPHA * rates[i] + (1 - EMA_ALPHA) * ema;
  }

  console.log(`[AFR] ${wellName}: EMA(${rates.length} rates, α=${EMA_ALPHA}) = ${ema.toFixed(6)} (${(ema * 24 * 60).toFixed(1)} min/ft)`);
  return ema;
}

