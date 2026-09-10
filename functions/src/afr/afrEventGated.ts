/**
 * AFR — PRODUCTION path. EVENT-GATED.
 *
 * Hard rule: with NO active validated washout event, this returns v1
 * byte-identically. Generic invalid/anomaly/change-point observations do NOT
 * switch the calculation into confidence weighting — that generic model is
 * shadow/replay research only (computeAfrHybrid), never production.
 *
 * Only an ACTIVE hot-oiler washout engages confidence weighting + a qualified
 * ON, and ONLY on local recovery Days 1-3 (the washout day itself is normal).
 * A newer washout restarts the window without stacking (handled upstream in
 * buildWashoutWindows). If washouts stop, every computation falls outside all
 * windows and the behavior is v1 forever with no config change.
 */
import type { AfrInterval, ConfidenceResult } from './afrTypes';
import type { AfrV2Policy } from './afrV2Policy';
import type { EventWindow } from './afrV2';
import { scoreConfidence } from './confidence';
import { computeAfrV1FromRates } from './afrV1';

export interface EventGatedOptions {
  /** Active washout recovery windows for THIS well (empty in production until a
   *  client event producer exists → always v1). */
  eventWindows?: EventWindow[];
  /** Qualified ON expressed in DAYS/FT (caller converts bblPerFoot/ON). Only
   *  consumed when the current computation is inside a recovery window. */
  qualifiedOnDaysPerFoot?: number | null;
  /** Timestamp of the computation (the just-arrived pull). Defaults to the last
   *  interval's timestamp. Decides which recovery day (if any) applies. */
  nowMs?: number;
}

export interface EventGatedResult {
  afr: number;
  effectiveForecast: number;
  mode: 'v1' | 'washout_recovery';
  washoutDayIndex: number | null;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeAfrEventGated(
  intervals: AfrInterval[],
  policy: AfrV2Policy,
  opts: EventGatedOptions = {},
): EventGatedResult {
  if (!intervals || intervals.length === 0) {
    return { afr: 0, effectiveForecast: 0, mode: 'v1', washoutDayIndex: null };
  }
  const rates = intervals.map((iv) => iv.flowRateDays);
  const v1 = computeAfrV1FromRates(rates);

  const windows = opts.eventWindows || [];
  const nowMs = opts.nowMs ?? intervals[intervals.length - 1].timestamp;
  const activeWin = windows.find((w) => nowMs >= w.startMs && nowMs < w.endMs) || null;

  // ── Not in a washout recovery window → v1 byte-identical ────────────────────
  if (!activeWin) {
    return { afr: v1, effectiveForecast: v1, mode: 'v1', washoutDayIndex: null };
  }

  // ── Active washout recovery (Day 1-3) → confidence weighting + qualified ON ──
  const priorValidRates: number[] = [];
  const results: ConfidenceResult[] = [];
  for (const iv of intervals) {
    const medianRate = priorValidRates.length >= 2 ? median(priorValidRates) : null;
    const knownDisturbance = windows.some((w) => iv.timestamp >= w.startMs && iv.timestamp < w.endMs);
    const r = scoreConfidence(iv, { medianRate, knownDisturbance }, policy);
    results.push(r);
    if (r.validity.valid) priorValidRates.push(iv.flowRateDays);
  }

  let ema: number | null = null;
  for (let i = 0; i < intervals.length; i++) {
    const w = results[i].weight;
    if (!results[i].validity.valid || w <= 0) continue;
    ema = ema == null ? rates[i] : ema + policy.emaAlpha * w * (rates[i] - ema);
  }
  if (ema == null) ema = v1;

  // Qualified ON nudges the EFFECTIVE forecast toward the post-disturbance rate
  // (never overwrites the underlying afr). Blend in days/ft; caller supplies the
  // ON already converted to days/ft.
  const blendW = policy.washout.onBlendWeight[activeWin.dayIndex - 1] ?? 0;
  const on = opts.qualifiedOnDaysPerFoot;
  const effective = on != null && on > 0 ? ema * (1 - blendW) + on * blendW : ema;

  return { afr: ema, effectiveForecast: effective, mode: 'washout_recovery', washoutDayIndex: activeWin.dayIndex };
}
