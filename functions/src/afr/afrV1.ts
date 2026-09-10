/**
 * AFR v1 — the DEPLOYED rate-array logic, extracted verbatim from
 * index.ts calculateAFR (post-fetch portion) + filterAnomalies +
 * getFlowRateAnomalyLevel, made pure/exported so it can be regression-tested and
 * replayed head-to-head against v2. Behavior is byte-for-byte equivalent to the
 * deployed function operating on the same ordered rate array. Do not "improve"
 * this file — it is the reference baseline.
 */
export const V1_ANOMALY_RATIO = 2.0;
export const V1_ITREVIEW_RATIO = 1.5;
export const V1_REGIME_SHIFT_THRESHOLD = 3;
export const V1_EMA_ALPHA = 0.4;
export const V1_STEP_THRESHOLD = 0.10;

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function getFlowRateAnomalyLevel(flowRate: number, medianRate: number): number {
  if (medianRate <= 0 || flowRate <= 0) return 0;
  const ratio = flowRate < medianRate ? medianRate / flowRate : flowRate / medianRate;
  if (ratio >= V1_ANOMALY_RATIO) return 2;
  if (ratio >= V1_ITREVIEW_RATIO) return 1;
  return 0;
}

export function filterAnomalies(flowRates: number[]): number[] {
  if (flowRates.length < 3) return flowRates;

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
  if (runStart >= 0 && directions.length - runStart >= V1_REGIME_SHIFT_THRESHOLD) {
    return filterAnomalies(flowRates.slice(runStart));
  }

  if (passOne.length < 5) return passOne;
  const overallMedian = median(passOne);
  const filtered = passOne.filter((rate) => getFlowRateAnomalyLevel(rate, overallMedian) < 2);
  if (filtered.length < 3) return flowRates;
  return filtered;
}

/** The deployed calculateAFR post-fetch computation over an ordered rate array. */
export function computeAfrV1FromRates(allRates: number[]): number {
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
      if (deviation <= V1_STEP_THRESHOLD) allHigher = false;
      if (deviation >= -V1_STEP_THRESHOLD) allLower = false;
    }
    if (allHigher || allLower) {
      const sorted = [...recentRates].sort((a, b) => a - b);
      return sorted[1];
    }
  }

  let ema = rates[0];
  for (let i = 1; i < rates.length; i++) {
    ema = V1_EMA_ALPHA * rates[i] + (1 - V1_EMA_ALPHA) * ema;
  }
  return ema;
}
