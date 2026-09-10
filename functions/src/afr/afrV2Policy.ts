/**
 * AFR v2 — central, tunable policy. ALL knobs live here (no scattered hardcoded
 * numbers) so the confidence/change-point behavior can be retuned from replay
 * evidence without touching logic. Nothing here is deployed by importing it; the
 * Cloud Function chooses whether to consume it.
 *
 * Three concepts (kept strictly separate):
 *   1. VALIDITY   — is the observation technically usable at all? Only genuinely
 *                   invalid observations get weight 0.0.
 *   2. CONFIDENCE — a second-stage LEARNING WEIGHT in [0,1] for valid
 *                   observations. Derived from data validity, timing quality,
 *                   and agreement with surrounding/subsequent evidence.
 *                   NEVER from prediction error alone (a correct measurement may
 *                   simply expose a stale AFR).
 *   3. EFFECTIVE FORECAST — a confidence-weighted aggregation of the underlying
 *                   AFR. A calendar/event WINDOW may modify individual weights
 *                   (see `washout`), but that window is only applied when an
 *                   explicit operational event exists to anchor it.
 */

/** Confidence tiers — starting candidates, tune from replay. */
export interface ConfidenceScale {
  normal: number;              // ordinary, consistent reading
  slightlyUnusual: number;     // valid but mildly off the surrounding trend
  knownDisturbance: number;    // an explicit operational disturbance/recovery
  highlyQuestionable: number;  // valid + technically possible, but far off
  invalid: number;             // technically impossible — the ONLY 0.0
}

export interface AfrV2Policy {
  /** Recency smoothing for the weighted EMA (matches v1 EMA_ALPHA baseline). */
  emaAlpha: number;
  /** Most-recent N intervals considered (matches v1 window). */
  windowSize: number;

  /** Consistency tiers vs the progressive median (ratio = max(r/m, m/r)). */
  consistency: {
    /** >= this ratio → the v1 "excluded" tier; in v2 a VALID one gets low weight. */
    anomalyRatio: number;      // v1 ANOMALY_RATIO = 2.0
    /** >= this ratio (and < anomalyRatio) → mildly unusual. */
    itReviewRatio: number;     // v1 ITREVIEW_RATIO = 1.5
  };

  confidence: ConfidenceScale;

  /** Change-point / regime acceptance — a genuine sustained change must
   *  EVENTUALLY gain confidence; repeated same-direction evidence cannot be
   *  suppressed forever merely because it differs from the old AFR. */
  regime: {
    /** consecutive same-direction off-trend intervals to accept a regime. */
    acceptAfter: number;       // preserves v1 REGIME_SHIFT_THRESHOLD = 3 intent
    /** once accepted, the confidence restored to the regime-defining intervals. */
    acceptedConfidence: number;
  };

  /** Validity thresholds (0.0 weight only). */
  validity: {
    /** flow rate (days/ft) at/above this is impossible → invalid (v1 sanity cap). */
    maxFlowRateDays: number;   // v1 rejects >= 365
    /** minimum plausible gap (ms) between two pulls; below → short-gap/dup → invalid. */
    minIntervalMs: number;
    /** a top-level change (feet) at/above this with no explaining haul is the
     *  "unexplained ~7-ft change" artifact → invalid. */
    unexplainedLevelJumpFeet: number;
    /** tolerance (feet) for matching a level change to its haul before the jump
     *  is deemed "unexplained". */
    haulMatchToleranceFeet: number;
  };

  /** Timing-quality weight modifiers (multiplicative, valid observations only). */
  timing: {
    /** interval shorter than this (ms) but still valid → reduced weight. */
    shortGapMs: number;
    shortGapFactor: number;
    /** a pull entered/edited long after its event has softer weight. */
    lateEntryFactor: number;
  };

  /**
   * WASHOUT recovery window. DISABLED by default: it requires an EXPLICIT
   * operational event (a recorded washout/hot-oiler/maintenance timestamp) to
   * anchor the window. Production currently records NO such event, so
   * `enabled:false` and the effective forecast NEVER claims to know Days 1-3.
   * When event capture exists, set `enabled:true`; the window then applies by
   * TIMESTAMP over the next `recoveryDays` LOCAL calendar days (well/company
   * timezone), the washout day itself is normal, a second event restarts the
   * window, and confidence during the window is capped at `dayConfidenceCap`.
   */
  washout: {
    enabled: boolean;
    /** number of post-event LOCAL calendar days with reduced confidence. */
    recoveryDays: number;                 // 3 per the final correction
    /** confidence cap per recovery day index (day 1 → [0], etc.). */
    dayConfidenceCap: number[];
    /** blend weight of a qualified ON into the EFFECTIVE forecast, per day. */
    onBlendWeight: number[];
    /** IANA timezone for local-calendar-day math (well/company). */
    timezone: string;
  };
}

/** Default policy — candidates aligned to deployed v1 behavior; tune via replay. */
export const AFR_V2_POLICY: AfrV2Policy = {
  emaAlpha: 0.4,
  windowSize: 15,
  consistency: { anomalyRatio: 2.0, itReviewRatio: 1.5 },
  confidence: {
    normal: 1.0,
    // RETAINED at full weight: the deployed AFR "retains 1.5x–<2.0x" readings, and
    // a 1.5–2.0x reading alone must NOT activate confidence weighting (stable
    // ordinary data stays v1 byte-identical). Kept as a named tier so replay can
    // tune it downward later if evidence supports it.
    slightlyUnusual: 1.0,
    knownDisturbance: 0.4,   // explicit operational-event window only (gated)
    highlyQuestionable: 0.1, // valid >=2.0x — an activation condition, low weight
    invalid: 0.0,            // technically impossible — the only 0.0
  },
  regime: { acceptAfter: 3, acceptedConfidence: 1.0 },
  validity: {
    maxFlowRateDays: 365,
    minIntervalMs: 5 * 60 * 1000,       // 5 min — below is a short-gap/duplicate pair
    unexplainedLevelJumpFeet: 7.0,      // the observed ~7-ft artifact
    haulMatchToleranceFeet: 1.0,
  },
  timing: { shortGapMs: 60 * 60 * 1000, shortGapFactor: 0.4, lateEntryFactor: 0.8 },
  washout: {
    enabled: false,                     // GATED: no explicit washout event exists in production
    recoveryDays: 3,
    dayConfidenceCap: [0.4, 0.4, 0.4],
    onBlendWeight: [0.6, 0.4, 0.2],
    timezone: 'America/Chicago',        // Williston, ND (well/company local)
  },
};
