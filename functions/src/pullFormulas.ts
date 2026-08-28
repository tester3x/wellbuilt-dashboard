// pullFormulas.ts — pure flow-rate / AFR billing formulas, extracted VERBATIM
// from processIncomingPull's calculateAFR (calculation separated from
// persistence). index.ts now imports these (single source of truth); the full
// functions suite proves behavior parity, and golden-fixture tests pin the exact
// outputs. Rounding, thresholds, anomaly exclusion, regime-shift reseed, step
// detection, and EMA are preserved exactly — do NOT approximate.

export const ANOMALY_RATIO = 2.0;     // 2x off median = excluded from AFR averaging
export const ITREVIEW_RATIO = 1.5;    // 1.5x off median = flagged but included in AFR
export const REGIME_SHIFT_THRESHOLD = 3;
export const EMA_ALPHA = 0.4;
export const AFR_STEP_THRESHOLD = 0.10;

export function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Returns: 0 = Normal, 1 = IT Review (1.5x-2x), 2 = Anomaly (>=2x, excluded from AFR)
export function getFlowRateAnomalyLevel(flowRate: number, medianRate: number): number {
  if (medianRate <= 0 || flowRate <= 0) return 0;
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

// Filter out Tier-2 anomalies (2x+ off median): progressive pass, regime-shift
// reseed, then overall-median re-check. Verbatim from index.ts.
export function filterAnomalies(flowRates: number[]): number[] {
  if (flowRates.length < 3) {
    return flowRates;
  }
  const knownRates: number[] = [];
  const passOne: number[] = [];
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
      passOne.push(rate);
      knownRates.push(rate);
      directions.push(0);
    }
  }
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
  if (passOne.length < 5) {
    return passOne;
  }
  const overallMedian = median(passOne);
  const filtered = passOne.filter((rate) => getFlowRateAnomalyLevel(rate, overallMedian) < 2);
  if (filtered.length < 3) {
    return flowRates;
  }
  return filtered;
}

/**
 * Compute AFR (days per foot) from the assembled recent-rates window (the most
 * recent 15 processed rates + the new rate). Pure tail of calculateAFR, verbatim:
 * <3 → last; anomaly filter; <3 → last; step detection (>=5, median of last 3);
 * else EMA(alpha=0.4). The DB read/sort that assembles `allRates` stays in
 * index.ts (persistence).
 */
export function computeAFRFromRates(allRates: number[]): number {
  if (allRates.length === 0) return 0;
  if (allRates.length < 3) return allRates[allRates.length - 1];

  const rates = filterAnomalies(allRates);

  if (rates.length === 0) return allRates[allRates.length - 1];
  if (rates.length < 3) return rates[rates.length - 1];

  if (rates.length >= 5) {
    const preStepRates = rates.slice(0, -3);
    const recentRates = rates.slice(-3);
    const preStepAvg = preStepRates.reduce((a, b) => a + b, 0) / preStepRates.length;
    let allHigher = true;
    let allLower = true;
    for (const rate of recentRates) {
      const deviation = (rate - preStepAvg) / preStepAvg;
      if (deviation <= AFR_STEP_THRESHOLD) allHigher = false;
      if (deviation >= -AFR_STEP_THRESHOLD) allLower = false;
    }
    if (allHigher || allLower) {
      const sorted = [...recentRates].sort((a, b) => a - b);
      return sorted[1];
    }
  }

  let ema = rates[0];
  for (let i = 1; i < rates.length; i++) {
    ema = EMA_ALPHA * rates[i] + (1 - EMA_ALPHA) * ema;
  }
  return ema;
}
