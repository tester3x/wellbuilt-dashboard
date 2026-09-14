/**
 * wbmLevelEstimator — WB‑M vc58 live estimated-level parity (Firebase-free, pure).
 *
 * Mirrors field WB‑M's 30-second WellView estimator so Dispatch shows and
 * classifies from the SAME estimated waterline as the driver's app.
 *
 * Verified WB‑M source: integration/wbm-android-vc58-emergency-20260912 @ 2bf7c9a
 * (estimator byte-identical to vc57 1975d041). APK carries no embedded SHA, so
 * this is an evidence-based, vector-verified reproduction (see tests A/B/C).
 *
 * Canonical estimator at one shared asOfMs:
 *   minutesSincePull = (asOfMs - pullTimeMs) / 60000
 *   if flowMinutesPerFoot > 0 and NOT wellDown:
 *     estimatedFeet = min(startingBottomFeet + minutesSincePull / flowMinutesPerFoot, 20)
 *   else: freeze at startingBottomFeet
 *
 * `flowRate` is "H:MM:SS" = minutes per FOOT. windowBblsDay / overnightBblsDay
 * are NEVER used for the displayed waterline (overnight only moves WB‑M's
 * bbl/day statistic).
 *
 * Display (WB‑M inch flooring): floor(feet*12 + 0.0001) whole inches, omit zero
 * inches ("7'" not "7'0\""), cap at 20 feet.
 */

export const MAX_LEVEL_FEET = 20;

/** Parse a level string to DECIMAL FEET. Handles "5'", "18'6\"", "6'7\"", "9", "20", "7'6". */
export function parseFeetDecimal(str: string | null | undefined): number | null {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s || s === '--' || s.toUpperCase() === 'DOWN') return null;
  const fi = s.match(/^(\d+)\s*'\s*(\d+)?\s*"?$/); // 18'6"  | 7'  | 7'6
  if (fi) return parseInt(fi[1], 10) + (fi[2] ? parseInt(fi[2], 10) / 12 : 0);
  const n = parseFloat(s.replace(/["']/g, ''));
  return isNaN(n) ? null : n; // bare number = feet
}

/** Parse "H:MM:SS" (minutes per foot) → minutes per foot. Invalid / non-positive → null. */
export function parseFlowMinutesPerFoot(flowRate: string | null | undefined): number | null {
  if (flowRate == null) return null;
  const s = String(flowRate).trim();
  const m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const minutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + parseInt(m[3], 10) / 60;
  return minutes > 0 ? minutes : null;
}

/**
 * WB‑M inch flooring. `floor(feet*12 + 0.0001)` whole inches (the +0.0001 epsilon
 * makes exact feet/inches survive float error, e.g. 6+7/12 → 79 not 78), omit
 * zero inches, cap at 20'. Null feet → '--'.
 */
export function formatFeetWBM(feet: number | null): string {
  if (feet == null || isNaN(feet)) return '--';
  const capped = Math.min(feet, MAX_LEVEL_FEET);
  const totalInches = Math.floor(capped * 12 + 0.0001);
  const ft = Math.floor(totalInches / 12);
  const inch = totalInches - ft * 12;
  return inch === 0 ? `${ft}'` : `${ft}'${inch}"`;
}

export interface EstimatorInputs {
  startingBottomFeet: number | null; // lastPullBottomLevel (fallback currentLevel)
  pullTimeMs: number | null;         // lastPullDateTimeUTC (fallback timestampUTC)
  flowMinutesPerFoot: number | null; // parsed flowRate
  wellDown: boolean;
}

export interface EstimateResult {
  /** Estimated current level in decimal feet (capped at 20), or null if no baseline. */
  feet: number | null;
  /** True only when a positive flow drove a live rise (not frozen/down). */
  hasFlow: boolean;
  /** True when the estimate hit the 20' cap. */
  capped: boolean;
  /** True when frozen at the baseline (no flow, or well down). */
  frozen: boolean;
}

/** Estimated current level (decimal feet) at a single shared asOfMs. */
export function estimateCurrentFeet(inp: EstimatorInputs, asOfMs: number): EstimateResult {
  const base = inp.startingBottomFeet;
  if (base == null) return { feet: null, hasFlow: false, capped: false, frozen: false };

  const flowOk = inp.flowMinutesPerFoot != null && inp.flowMinutesPerFoot > 0;
  if (inp.wellDown || !flowOk || inp.pullTimeMs == null) {
    // Freeze at the starting bottom — no fake rise, no urgency from time alone.
    return { feet: Math.min(base, MAX_LEVEL_FEET), hasFlow: false, capped: base >= MAX_LEVEL_FEET, frozen: true };
  }

  const minutesSincePull = (asOfMs - inp.pullTimeMs) / 60000;
  const rise = minutesSincePull > 0 ? minutesSincePull / (inp.flowMinutesPerFoot as number) : 0;
  const raw = base + rise;
  const feet = Math.min(raw, MAX_LEVEL_FEET);
  return { feet, hasFlow: true, capped: raw >= MAX_LEVEL_FEET, frozen: false };
}

/** readyLevel = allowedBottom + loadBbls / bblsPerFoot (decimal feet), or null. */
export function readyLevelFeet(args: { allowedBottomFeet: number | null; loadBbls: number | null; bblsPerFoot: number | null }): number | null {
  const { allowedBottomFeet, loadBbls, bblsPerFoot } = args;
  if (allowedBottomFeet == null || loadBbls == null || !bblsPerFoot || bblsPerFoot <= 0) return null;
  return allowedBottomFeet + loadBbls / bblsPerFoot;
}

/**
 * Absolute predicted ready time (ms) — when the estimate reaches readyFeet.
 *   readyAt = pullTimeMs + (readyFeet - startingBottomFeet) * flowMinutesPerFoot * 60000
 * Null when it cannot be forecast (no flow, well down, or missing basis/target).
 * May be in the past (already ready) — callers treat past as "ready now".
 */
export function predictedReadyAtMs(inp: EstimatorInputs, readyFeet: number | null): number | null {
  if (readyFeet == null) return null;
  if (inp.wellDown) return null;
  if (inp.startingBottomFeet == null || inp.pullTimeMs == null) return null;
  const flow = inp.flowMinutesPerFoot;
  if (flow == null || flow <= 0) return null;
  const feetToGo = readyFeet - inp.startingBottomFeet;
  return inp.pullTimeMs + feetToGo * flow * 60000;
}
