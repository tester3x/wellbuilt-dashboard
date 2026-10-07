const ANOMALY_RATIO = 2.0;     // 2x off median = excluded from AFR averaging
const ITREVIEW_RATIO = 1.5;    // 1.5x off median = flagged but included in AFR

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
//   1b. Regime-shift detection — if the LAST N pulls were all rejected as Tier-2
//       anomalies in the SAME direction, the baseline itself is stale (e.g. a
//       fresh-tank start followed by a long lapse, pump replacement, or workover).
//       Reseed from the rejection run as the new baseline and recurse. Mirrors
//       the step detector at lines ~755-778 but operates on rates that filtered
//       OUT, which the step detector can't see.
//   2. Final pass with the OVERALL median of pass-1 results — catches early
//      outliers that were grandfathered in before there was enough baseline
//      data (matches the dashboard's anomaly badges so AFR and the UI agree).
// Returns rates with Tier 2 anomalies removed.
const REGIME_SHIFT_THRESHOLD = 3;
function filterAnomalies(flowRates: number[]): number[] {
  if (flowRates.length < 3) {
    return flowRates;
  }

  // Pass 1: progressive (also tracks rejection direction for regime-shift detection)
  const knownRates: number[] = [];
  const passOne: number[] = [];
  // 0 = accepted, +1 = rejected as higher than baseline, -1 = rejected as lower
  const directions: number[] = [];
  for (const rate of flowRates) {
    if (knownRates.length >= 3) {
      const medianRate = median(knownRates);
      const level = getFlowRateAnomalyLevel(rate, medianRate);
      if (level < 2) {
        passOne.push(rate);
        knownRates.push(rate);
        directions.push(0);
      } else {
        directions.push(rate > medianRate ? 1 : -1);
      }
    } else {
      // Not enough baseline yet — include for now; pass 2 will re-check.
      passOne.push(rate);
      knownRates.push(rate);
      directions.push(0);
    }
  }

  // Pass 1b: regime-shift escape. Scan tail for consecutive same-direction
  // Tier-2 rejections. If we find a run of REGIME_SHIFT_THRESHOLD or more,
  // the baseline is stale — reseed from the rejection run and recurse.
  let runDir = 0;
  let runStart = -1;
  for (let i = directions.length - 1; i >= 0; i--) {
    const d = directions[i];
    if (d === 0) break;
    if (runDir === 0) runDir = d;
    if (d !== runDir) break;
    runStart = i;
  }
  if (runStart >= 0 && (directions.length - runStart) >= REGIME_SHIFT_THRESHOLD) {
    return filterAnomalies(flowRates.slice(runStart));
  }

  // Pass 2: re-check every kept rate against the OVERALL median.
  // This catches early packets that got grandfathered in during pass 1.
  if (passOne.length < 5) {
    return passOne; // Too few to safely re-filter
  }
  const overallMedian = median(passOne);
  const filtered = passOne.filter(rate => getFlowRateAnomalyLevel(rate, overallMedian) < 2);

  if (filtered.length < 3) {
    return flowRates; // Fallback if too many filtered
  }
  return filtered;
}


const EMA_ALPHA = 0.4;
/** Same anomaly/step/EMA policy as the canonical pull processor. */
export function historicalAverage(allRates: number[]): number {
  allRates = allRates.filter(rate => Number.isFinite(rate) && rate > 0).slice(-15);
  if (!allRates.length) return 0;
  if (allRates.length < 3) return allRates[allRates.length - 1];
  const rates = filterAnomalies(allRates);
  if (!rates.length) return allRates[allRates.length - 1];
  if (rates.length < 3) return rates[rates.length - 1];
  // Step detection: Check if last 3 are ALL >10% off in same direction
  // Catches sudden regime changes (e.g., well workover, pump change)
  const STEP_THRESHOLD = 0.10;
  if (rates.length >= 5) {
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
  return ema;
}


