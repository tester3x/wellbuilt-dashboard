/**
 * AFR HYBRID orchestrator — PURE (no I/O).
 *
 * Requirement: stable, ordinary data must follow the v1 calculation
 * BYTE-IDENTICALLY. Confidence weighting engages ONLY when a proven condition is
 * present: an invalid observation, a >=2.0x anomaly, a change-point (sustained
 * same-direction run), or an explicit operational-event window. When NOTHING
 * activates, the result is exactly computeAfrV1FromRates — no per-well hindsight,
 * decided live from the data itself.
 *
 * When activated:
 *   - invalid (0.0) cannot steer the trend;
 *   - a valid >=2.0x anomaly contributes "a little piece" (0.1);
 *   - 1.5–<2.0x is retained at full weight (v1 parity);
 *   - a change-point run restores confidence so a sustained regime change is
 *     learned, never suppressed forever;
 *   - event-window intervals are capped (knownDisturbance) — GATED: no explicit
 *     event source in production, so no window is ever passed there.
 * Prediction error is never an input.
 */
import type { AfrInterval, AfrHybridResult, ConfidenceResult, ActivationReason } from './afrTypes';
import type { AfrV2Policy } from './afrV2Policy';
import { scoreConfidence } from './confidence';
import { computeAfrV1FromRates } from './afrV1';

/** A local-calendar-day washout recovery window (built by washoutWindow.ts). */
export interface EventWindow {
  startMs: number;
  endMs: number;
  /** 1-based recovery day index (Day 1/2/3). */
  dayIndex: number;
}

export interface HybridOptions {
  /** Explicit operational-event windows (washout recovery). Empty/omitted in
   *  production — no event producer exists yet. */
  eventWindows?: EventWindow[];
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function inAnyWindow(ts: number, windows?: EventWindow[]): boolean {
  return !!windows && windows.some((w) => ts >= w.startMs && ts < w.endMs);
}

export function computeAfrHybrid(
  intervalsIn: AfrInterval[],
  policy: AfrV2Policy,
  opts: HybridOptions = {},
): AfrHybridResult {
  const empty: AfrHybridResult = {
    afr: 0, effectiveForecast: 0, perInterval: [], regimeAccepted: false,
    mode: 'v1_passthrough', activated: false, activationReasons: [],
  };
  if (!intervalsIn || intervalsIn.length === 0) return empty;

  const intervals = intervalsIn.slice(-policy.windowSize);
  const rates = intervals.map((iv) => iv.flowRateDays);

  // Classify each interval vs the running median of PRIOR valid rates.
  const priorValidRates: number[] = [];
  const results: ConfidenceResult[] = [];
  const directions: number[] = [];
  for (const iv of intervals) {
    const medianRate = priorValidRates.length >= 2 ? median(priorValidRates) : null;
    const knownDisturbance = inAnyWindow(iv.timestamp, opts.eventWindows);
    const r = scoreConfidence(iv, { medianRate, knownDisturbance }, policy);
    results.push(r);
    if (r.validity.valid) {
      priorValidRates.push(iv.flowRateDays);
      // Change-point direction uses DEVIATION from the surrounding median (either
      // off-trend tier), independent of the learning weight.
      if (medianRate != null && (r.tier === 'slightlyUnusual' || r.tier === 'highlyQuestionable')) {
        directions.push(iv.flowRateDays > medianRate ? 1 : -1);
      } else {
        directions.push(0);
      }
    } else {
      directions.push(0);
    }
  }

  // Change-point run (tail of consecutive same-direction off-trend intervals).
  let runDir = 0;
  let runStart = -1;
  for (let i = directions.length - 1; i >= 0; i--) {
    const d = directions[i];
    if (d === 0) break;
    if (runDir === 0) runDir = d;
    if (d !== runDir) break;
    runStart = i;
  }
  const changePoint = runStart >= 0 && directions.length - runStart >= policy.regime.acceptAfter;

  // Activation conditions.
  const reasons: ActivationReason[] = [];
  if (results.some((r) => !r.validity.valid)) reasons.push('invalid');
  if (results.some((r) => r.validity.valid && r.tier === 'highlyQuestionable')) reasons.push('anomaly');
  if (changePoint) reasons.push('change_point');
  if (results.some((r) => r.validity.valid && r.tier === 'knownDisturbance')) reasons.push('event');
  const activated = reasons.length > 0;

  const perIntervalBase = intervals.map((iv, i) => ({
    key: iv.key, timestamp: iv.timestamp, rate: iv.flowRateDays, ...results[i],
  }));

  // ── Not activated → byte-identical v1 passthrough ──────────────────────────
  if (!activated) {
    const afr = computeAfrV1FromRates(rates);
    return {
      afr, effectiveForecast: afr, perInterval: perIntervalBase,
      regimeAccepted: false, mode: 'v1_passthrough', activated: false, activationReasons: [],
    };
  }

  // ── Activated → confidence-weighted path ───────────────────────────────────
  let regimeAccepted = false;
  if (changePoint) {
    regimeAccepted = true;
    for (let i = runStart; i < results.length; i++) {
      if (results[i].validity.valid) {
        results[i] = { ...results[i], weight: policy.regime.acceptedConfidence, regimeAccepted: true };
      }
    }
  }

  let ema: number | null = null;
  for (let i = 0; i < intervals.length; i++) {
    const w = results[i].weight;
    if (!results[i].validity.valid || w <= 0) continue;
    ema = ema == null ? rates[i] : ema + policy.emaAlpha * w * (rates[i] - ema);
  }
  if (ema == null) {
    const lastValidIdx = [...results].reverse().findIndex((r) => r.validity.valid);
    ema = lastValidIdx >= 0 ? rates[rates.length - 1 - lastValidIdx] : rates[rates.length - 1];
  }

  const perInterval = intervals.map((iv, i) => ({
    key: iv.key, timestamp: iv.timestamp, rate: iv.flowRateDays, ...results[i],
  }));

  return {
    afr: ema, effectiveForecast: ema, perInterval, regimeAccepted,
    mode: 'v2_active', activated: true, activationReasons: reasons,
  };
}
