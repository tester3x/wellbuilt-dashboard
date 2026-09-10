/**
 * AFR v2 orchestrator — PURE (no I/O). Turns a chronological interval sequence
 * into a confidence-weighted AFR plus per-interval diagnostics.
 *
 * Pipeline:
 *   1. Window to the most-recent N intervals.
 *   2. Per interval: consistency vs the running median of PRIOR VALID rates →
 *      confidence weight (validity 0.0 excluded from the trend entirely; a
 *      questionable-but-valid reading contributes "a little piece").
 *   3. Change-point acceptance: a run of >= regime.acceptAfter consecutive
 *      same-direction off-trend intervals is a genuine regime shift — restore
 *      their confidence so a sustained change is learned, never suppressed
 *      forever.
 *   4. Weighted EMA: ema += alpha * weight * (rate - ema). Zero-weight (invalid)
 *      intervals cannot move the trend; low-weight ones nudge it slightly.
 *
 * Effective forecast == afr here. The washout-window ON blend is intentionally
 * NOT applied (no explicit event source in production; policy.washout.enabled
 * is false) — the forecast never pretends to know post-washout Days 1-3.
 */
import type { AfrInterval, AfrV2Result, ConfidenceResult } from './afrTypes';
import type { AfrV2Policy } from './afrV2Policy';
import { scoreConfidence } from './confidence';

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeAfrV2(intervalsIn: AfrInterval[], policy: AfrV2Policy): AfrV2Result {
  const empty: AfrV2Result = { afr: 0, effectiveForecast: 0, perInterval: [], regimeAccepted: false };
  if (!intervalsIn || intervalsIn.length === 0) return empty;

  // Most-recent N (input assumed chronological ascending).
  const intervals = intervalsIn.slice(-policy.windowSize);

  // Per-interval confidence vs the running median of prior VALID rates.
  const priorValidRates: number[] = [];
  const results: ConfidenceResult[] = [];
  const directions: number[] = []; // +1 higher than surrounding median, -1 lower, 0 on-trend/none
  for (const iv of intervals) {
    const medianRate = priorValidRates.length >= 2 ? median(priorValidRates) : null;
    const r = scoreConfidence(iv, { medianRate }, policy);
    results.push(r);
    if (r.validity.valid) {
      priorValidRates.push(iv.flowRateDays);
      if (medianRate != null && (r.tier === 'slightlyUnusual' || r.tier === 'highlyQuestionable')) {
        directions.push(iv.flowRateDays > medianRate ? 1 : -1);
      } else {
        directions.push(0);
      }
    } else {
      directions.push(0);
    }
  }

  // Change-point acceptance: a tail run of same-direction off-trend intervals.
  let runDir = 0;
  let runStart = -1;
  for (let i = directions.length - 1; i >= 0; i--) {
    const d = directions[i];
    if (d === 0) break;
    if (runDir === 0) runDir = d;
    if (d !== runDir) break;
    runStart = i;
  }
  let regimeAccepted = false;
  if (runStart >= 0 && directions.length - runStart >= policy.regime.acceptAfter) {
    regimeAccepted = true;
    for (let i = runStart; i < results.length; i++) {
      if (results[i].validity.valid) {
        results[i] = { ...results[i], weight: policy.regime.acceptedConfidence, regimeAccepted: true };
      }
    }
  }

  // Weighted EMA over the windowed intervals.
  let ema: number | null = null;
  for (let i = 0; i < intervals.length; i++) {
    const rate = intervals[i].flowRateDays;
    const w = results[i].weight;
    if (!results[i].validity.valid || w <= 0) continue; // zero-weight cannot steer the trend
    if (ema == null) {
      ema = rate; // seed from the first contributing rate
    } else {
      ema = ema + policy.emaAlpha * w * (rate - ema);
    }
  }

  // Fallback: nothing contributed → last valid rate, else last raw rate (mirrors
  // v1's "fall back to unfiltered when fewer than three usable pulls remain").
  if (ema == null) {
    const lastValid = [...intervals].reverse().find((_, i) => results[results.length - 1 - i].validity.valid);
    ema = lastValid ? lastValid.flowRateDays : intervals[intervals.length - 1].flowRateDays;
  }

  const perInterval = intervals.map((iv, i) => ({
    key: iv.key,
    timestamp: iv.timestamp,
    rate: iv.flowRateDays,
    ...results[i],
  }));

  return { afr: ema, effectiveForecast: ema, perInterval, regimeAccepted };
}
