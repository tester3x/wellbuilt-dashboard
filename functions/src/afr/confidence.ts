/**
 * CONFIDENCE — the second-stage learning weight in [0,1] for a VALID interval.
 *
 * Inputs (per the packet): data validity (already decided), consistency with
 * SURROUNDING evidence (ratio vs the running median of prior valid rates), and
 * timing quality (short-gap-but-valid, late entry). A "known operational
 * disturbance" tier exists but is only reached via an explicit event window
 * (gated). Prediction error is deliberately NOT used — a correct measurement
 * may simply expose a stale AFR.
 *
 * A valid >=2.0x observation lands in `highlyQuestionable` (low weight), never
 * 0.0; only VALIDITY yields 0.0.
 */
import type { AfrInterval, ConfidenceResult, ValidityVerdict, ConfidenceTier } from './afrTypes';
import type { AfrV2Policy } from './afrV2Policy';
import { decideValidity } from './validity';

/** Symmetric consistency ratio (matches v1 getFlowRateAnomalyLevel math). */
export function consistencyRatio(rate: number, medianRate: number): number {
  if (medianRate <= 0 || rate <= 0) return 1;
  return rate < medianRate ? medianRate / rate : rate / medianRate;
}

export interface ConfidenceContext {
  /** Median of the surrounding (prior valid) rates, or null if no baseline yet. */
  medianRate: number | null;
  /** Optional: the pull is a known disturbance interval (explicit event window).
   *  Left false generically — set only by an enabled, event-anchored window. */
  knownDisturbance?: boolean;
}

export function scoreConfidence(
  iv: AfrInterval,
  ctx: ConfidenceContext,
  policy: AfrV2Policy,
): ConfidenceResult {
  const validity: ValidityVerdict = decideValidity(iv, policy);
  if (!validity.valid) {
    return { weight: policy.confidence.invalid, tier: 'invalid', validity, timingFactor: 1, regimeAccepted: false };
  }

  // Consistency tier vs surrounding evidence.
  let tier: ConfidenceTier;
  if (ctx.knownDisturbance) {
    tier = 'knownDisturbance';
  } else if (ctx.medianRate == null) {
    tier = 'normal'; // no baseline yet — cannot judge consistency
  } else {
    const ratio = consistencyRatio(iv.flowRateDays, ctx.medianRate);
    if (ratio >= policy.consistency.anomalyRatio) tier = 'highlyQuestionable';
    else if (ratio >= policy.consistency.itReviewRatio) tier = 'slightlyUnusual';
    else tier = 'normal';
  }

  const base =
    tier === 'knownDisturbance' ? policy.confidence.knownDisturbance
    : tier === 'highlyQuestionable' ? policy.confidence.highlyQuestionable
    : tier === 'slightlyUnusual' ? policy.confidence.slightlyUnusual
    : policy.confidence.normal;

  // Timing quality (multiplicative), valid observations only.
  let timingFactor = 1;
  if (iv.intervalMs !== undefined && iv.intervalMs < policy.timing.shortGapMs) {
    timingFactor *= policy.timing.shortGapFactor;
  }
  if (iv.enteredAtMs !== undefined && Number.isFinite(iv.enteredAtMs)) {
    // "late" = entered well after the pull's own timestamp (> one recovery day).
    const lateMs = iv.enteredAtMs - iv.timestamp;
    if (lateMs > 24 * 60 * 60 * 1000) timingFactor *= policy.timing.lateEntryFactor;
  }

  const weight = Math.max(0, Math.min(1, base * timingFactor));
  return { weight, tier, validity, timingFactor, regimeAccepted: false };
}
