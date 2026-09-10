/**
 * VALIDITY — is an observation technically usable at all? This is the ONLY gate
 * that may assign weight 0.0. It proves IMPOSSIBILITY; it never guesses. Missing
 * OPTIONAL data (no top level, no haul recorded) can't prove impossibility, so
 * it is treated as valid (and left to CONFIDENCE to down-weight if off-trend).
 *
 * Prediction error is intentionally NOT an input here (nor in confidence): a
 * correct measurement can legitimately expose a stale AFR.
 */
import type { AfrInterval, ValidityVerdict } from './afrTypes';
import type { AfrV2Policy } from './afrV2Policy';

export function decideValidity(iv: AfrInterval, policy: AfrV2Policy): ValidityVerdict {
  const v = policy.validity;

  // Impossible rate: non-finite, non-positive, or beyond the physical sanity cap.
  if (!Number.isFinite(iv.flowRateDays) || iv.flowRateDays <= 0) {
    return { valid: false, reason: 'impossible_rate' };
  }
  if (iv.flowRateDays >= v.maxFlowRateDays) {
    return { valid: false, reason: 'impossible_rate' };
  }

  // Corrupt timing: no usable timestamp.
  if (!Number.isFinite(iv.timestamp) || iv.timestamp <= 0) {
    return { valid: false, reason: 'corrupt_timing' };
  }

  // Interval sanity (only when we actually know the gap).
  if (iv.intervalMs !== undefined) {
    if (!Number.isFinite(iv.intervalMs) || iv.intervalMs <= 0) {
      return { valid: false, reason: 'corrupt_timing' };
    }
    if (iv.intervalMs < v.minIntervalMs) {
      return { valid: false, reason: 'short_gap_duplicate' };
    }
  }

  // Unexplained ~7-ft top-level change: only provable when BOTH levels and the
  // haul (with a conversion) are present. A big level jump that the recorded
  // haul cannot account for is the corrupt artifact → invalid. Missing any of
  // these inputs = not provable = valid.
  if (
    iv.topLevelFeet !== undefined &&
    iv.priorTopLevelFeet !== undefined &&
    iv.bblsTaken !== undefined &&
    iv.bblPerFoot !== undefined &&
    iv.bblPerFoot > 0
  ) {
    const observedDropFeet = iv.priorTopLevelFeet - iv.topLevelFeet; // level fell by the haul
    const haulDropFeet = iv.bblsTaken / iv.bblPerFoot;
    const unexplained = Math.abs(observedDropFeet - haulDropFeet);
    if (
      Math.abs(observedDropFeet) >= v.unexplainedLevelJumpFeet &&
      unexplained > v.haulMatchToleranceFeet
    ) {
      return { valid: false, reason: 'unexplained_level_jump' };
    }
  }

  return { valid: true, reason: 'ok' };
}
