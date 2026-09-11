/**
 * AFR v2 — AUTOMATIC, EVENT-FREE per-well transient detection (PURE, no I/O).
 *
 * Goal: resist temporary washout / hot-oiler disturbances WITHOUT any driver,
 * dispatcher, weekday, or explicit washout-event input, while still adapting to a
 * genuine sustained production-regime change. Each well is judged ONLY against
 * its OWN robust history (median + MAD) — never a global/Gabriel cutoff, never a
 * calendar day. Prediction error is never an input. ON is untouched (a separate
 * concern; see calculateOvernightBblsPerDay) — this never activates or classifies
 * a transient from ON.
 *
 * State machine (per well, single deterministic pass over time-ordered intervals):
 *   STABLE  — inside the robust band. Full/timing-adjusted weight; updates baseline.
 *   TRANSIENT — entered on a sudden off-trend interval (canonically a positive
 *               spike). The disturbed interval is RETAINED but given minimal
 *               weight, and following high/low disturbed intervals are suppressed
 *               too, so a transient cannot inflate/destabilize AFR. It is NOT
 *               labeled a washout. Baseline is NOT updated by transient intervals.
 *   REGIME  — if >= regimeAcceptAfter consecutive off-trend intervals are mutually
 *               consistent in the SAME direction, a real regime change is accepted:
 *               their weight is restored and the baseline moves to the new level.
 * Exit TRANSIENT when either (a) returnToStableCount consecutive in-band qualified
 * intervals occur, or (b) a bounded expiry (maxTransientIntervals) is reached —
 * never suppress forever. A fresh positive spike after returning restarts TRANSIENT
 * independently.
 */
import type { AfrInterval, ValidityReason } from './afrTypes';
import type { AfrV2Policy } from './afrV2Policy';
import { decideValidity } from './validity';

export type AutoReason =
  | 'stable'
  | 'timing-low-confidence'
  | 'inferred-transient'
  | 'returning-to-baseline'
  | 'accepted-regime-change'
  | 'invalid';

export type AutoState = 'STABLE' | 'TRANSIENT' | 'REGIME';

export interface AutoIntervalResult {
  key: string;
  timestamp: number;
  rate: number;
  valid: boolean;
  validityReason: ValidityReason;
  reason: AutoReason;
  weight: number;                 // learning weight in [0,1]
  baselineMedian: number | null;  // robust center at decision time (null until seeded)
  robustScore: number | null;     // (rate - median) / (madNormalize * MAD_floored)
  offTrend: boolean;
  direction: -1 | 0 | 1;
  state: AutoState;               // state AFTER processing this interval
}

export interface AutoResult {
  afr: number;
  effectiveForecast: number;      // === afr (ON never overwrites it here)
  mode: 'stable' | 'transient_active' | 'regime_changed';
  regimeAccepted: boolean;
  perInterval: AutoIntervalResult[];
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Robust dispersion (median absolute deviation) with dead-well guards. */
function robustScale(rates: number[], med: number, policy: AfrV2Policy): number {
  const at = policy.autoTransient;
  const mad = median(rates.map((r) => Math.abs(r - med)));
  const scaled = at.madNormalize * mad;
  // Dead-well / ultra-stable guard: a near-zero MAD would make any tiny wobble
  // look like a huge robust score. Floor the scale to a fraction of the median
  // (relative) AND an absolute minimum (days/ft), so low/dead baselines are not
  // misclassified by ratios alone.
  const floor = Math.max(at.madFloorFrac * Math.abs(med), at.madFloorAbs);
  return Math.max(scaled, floor);
}

/** Multiplicative timing-quality modifier (short gap / late entry), valid obs only. */
function timingFactor(iv: AfrInterval, policy: AfrV2Policy): number {
  let f = 1;
  if (iv.intervalMs !== undefined && iv.intervalMs > 0 && iv.intervalMs < policy.timing.shortGapMs) {
    f *= policy.timing.shortGapFactor;
  }
  if (iv.enteredAtMs !== undefined && Number.isFinite(iv.enteredAtMs) && iv.enteredAtMs - iv.timestamp > policy.timing.lateEntryMs) {
    f *= policy.timing.lateEntryFactor;
  }
  return f;
}

/** Are all rates mutually consistent within a robust band around their median? */
function mutuallyConsistent(rates: number[], policy: AfrV2Policy): boolean {
  if (rates.length < 2) return true;
  const med = median(rates);
  const scale = robustScale(rates, med, policy);
  return rates.every((r) => Math.abs(r - med) <= policy.autoTransient.regimeConsistencyK * scale);
}

export function computeAfrAuto(intervalsIn: AfrInterval[], policy: AfrV2Policy): AutoResult {
  const at = policy.autoTransient;
  if (!intervalsIn || intervalsIn.length === 0) {
    return { afr: 0, effectiveForecast: 0, mode: 'stable', regimeAccepted: false, perInterval: [] };
  }
  // Time-ordered; keep only the most recent windowSize (deterministic).
  const intervals = [...intervalsIn].sort((a, b) => a.timestamp - b.timestamp).slice(-policy.windowSize);

  // stableRates defines the well's own baseline (valid, stable/regime rates only —
  // transient intervals never poison it).
  let stableRates: number[] = [];
  let state: AutoState = 'STABLE';
  let transientCount = 0;   // intervals since entering TRANSIENT
  let returnCount = 0;      // consecutive in-band intervals during TRANSIENT
  let runDir: 0 | 1 | -1 = 0;
  let runRates: number[] = [];   // consecutive same-direction off-trend rates (regime candidate)
  const runIdx: number[] = [];   // their positions in `out`

  const out: AutoIntervalResult[] = [];

  const baselineOf = (): { med: number | null; scale: number } => {
    if (stableRates.length < at.minBaseline) return { med: null, scale: 0 };
    const recent = stableRates.slice(-policy.windowSize);
    const med = median(recent);
    return { med, scale: robustScale(recent, med, policy) };
  };

  for (const iv of intervals) {
    const validity = decideValidity(iv, policy);
    const base: AutoIntervalResult = {
      key: iv.key, timestamp: iv.timestamp, rate: iv.flowRateDays,
      valid: validity.valid, validityReason: validity.reason,
      reason: 'stable', weight: 0, baselineMedian: null, robustScore: null,
      offTrend: false, direction: 0, state,
    };

    // ── Invalid → retained, weight 0, does not move baseline or state ──────────
    if (!validity.valid) {
      out.push({ ...base, reason: 'invalid', weight: 0, state });
      continue;
    }

    const { med, scale } = baselineOf();
    const tf = timingFactor(iv, policy);

    // ── Seeding: not enough baseline yet → treat as stable seed ────────────────
    if (med == null) {
      stableRates.push(iv.flowRateDays);
      out.push({ ...base, reason: tf < 1 ? 'timing-low-confidence' : 'stable', weight: 1 * tf, baselineMedian: null, robustScore: null, state });
      continue;
    }

    const robustScore = (iv.flowRateDays - med) / scale;
    const offTrend = Math.abs(robustScore) >= at.madScaleK;
    const direction: -1 | 0 | 1 = !offTrend ? 0 : robustScore > 0 ? 1 : -1;
    const b: AutoIntervalResult = { ...base, baselineMedian: med, robustScore, offTrend, direction, state };

    // helper: append to the same-direction regime run (resets on direction change)
    const pushRun = (dir: 1 | -1, idx: number) => {
      if (runDir !== dir) { runDir = dir; runRates = []; runIdx.length = 0; }
      runRates.push(iv.flowRateDays); runIdx.push(idx);
    };
    // helper: try to accept a regime change from the current run
    const tryAcceptRegime = (): boolean => {
      if (runRates.length >= at.regimeAcceptAfter && mutuallyConsistent(runRates, policy)) {
        // Restore full weight to the run intervals; move baseline to the new level.
        for (const j of runIdx) { out[j].weight = policy.regime.acceptedConfidence; out[j].reason = 'accepted-regime-change'; out[j].state = 'REGIME'; }
        state = 'REGIME';
        stableRates = [...runRates];
        transientCount = 0; returnCount = 0;
        return true;
      }
      return false;
    };

    const entryState: AutoState = state;
    // STABLE and REGIME share handling (both are "on a settled baseline"); the
    // fall-through below is the TRANSIENT case. (!== avoids a TS literal-narrowing
    // quirk where 'REGIME' — assigned only inside a closure — looks unreachable.)
    if (entryState !== 'TRANSIENT') {
      if (!offTrend) {
        // Inside the band → stable; timing may soften weight; updates baseline.
        state = 'STABLE';
        runDir = 0; runRates = []; runIdx.length = 0;
        stableRates.push(iv.flowRateDays);
        out.push({ ...b, reason: tf < 1 ? 'timing-low-confidence' : 'stable', weight: 1 * tf, state });
      } else {
        // Sudden off-trend from a stable/regime baseline → enter TRANSIENT.
        state = 'TRANSIENT'; transientCount = 1; returnCount = 0;
        const idx = out.length;
        out.push({ ...b, reason: 'inferred-transient', weight: at.transientWeight * tf, state });
        pushRun(direction as 1 | -1, idx);
        tryAcceptRegime(); // a lone spike won't reach the threshold; guards future
      }
      continue;
    }

    // ── state === 'TRANSIENT' ──────────────────────────────────────────────────
    transientCount += 1;
    if (!offTrend) {
      returnCount += 1;
      const idx = out.length;
      out.push({ ...b, reason: 'returning-to-baseline', weight: at.transientWeight * tf, state });
      if (returnCount >= at.returnToStableCount) {
        // Confirmed return: exit to STABLE and let the in-band returning rates
        // re-seed the baseline (only the qualified in-band ones).
        state = 'STABLE'; transientCount = 0; returnCount = 0;
        runDir = 0; runRates = []; runIdx.length = 0;
        const returned = out.slice(-at.returnToStableCount).filter((r) => r.valid && !r.offTrend).map((r) => r.rate);
        stableRates.push(...returned);
        // mark the confirming interval as stable now that the baseline holds
        out[idx].reason = tf < 1 ? 'timing-low-confidence' : 'stable';
      }
      continue;
    }

    // still off-trend during a transient → suppressed; extend/curb the regime run
    returnCount = 0;
    const idx = out.length;
    out.push({ ...b, reason: 'inferred-transient', weight: at.transientWeight * tf, state });
    pushRun(direction as 1 | -1, idx);
    if (tryAcceptRegime()) continue;

    // bounded expiry — never suppress indefinitely.
    if (transientCount >= at.maxTransientIntervals) {
      state = 'STABLE'; transientCount = 0; returnCount = 0;
      runDir = 0; runRates = []; runIdx.length = 0;
      // Re-seed baseline from the recent tail of valid rates so AFR can move on.
      const tail = out.slice(-at.returnToStableCount).filter((r) => r.valid).map((r) => r.rate);
      stableRates.push(...(tail.length ? tail : [iv.flowRateDays]));
      out[idx].reason = 'returning-to-baseline';
    }
  }

  // ── Confidence-weighted EMA over valid intervals (transients minimal) ────────
  let ema: number | null = null;
  for (let i = 0; i < intervals.length; i++) {
    const r = out[i];
    if (!r.valid || r.weight <= 0) continue;
    ema = ema == null ? r.rate : ema + policy.emaAlpha * r.weight * (r.rate - ema);
  }
  if (ema == null) {
    const lastValid = [...out].reverse().find((r) => r.valid);
    ema = lastValid ? lastValid.rate : intervals[intervals.length - 1].flowRateDays;
  }

  const regimeAccepted = out.some((r) => r.reason === 'accepted-regime-change');
  const finalState = out.length ? out[out.length - 1].state : 'STABLE';
  const mode: AutoResult['mode'] = regimeAccepted ? 'regime_changed' : finalState === 'TRANSIENT' ? 'transient_active' : 'stable';

  return { afr: ema, effectiveForecast: ema, mode, regimeAccepted, perInterval: out };
}
