/**
 * Shared AFR v2 types. An "interval" is the DERIVED pull-to-pull segment that
 * produced one flow rate — confidence attaches to the interval, not vaguely to a
 * row/day, and washout modifiers (when an event source exists) are applied to it
 * by timestamp.
 */

/** One derived pull interval fed to validity/confidence. Optional fields are
 *  populated when the source packet carries them; their ABSENCE never proves
 *  invalidity (we only ever prove impossibility). */
export interface AfrInterval {
  key: string;                 // packet key (used for de-duplication)
  timestamp: number;           // ms epoch of the pull that ends this interval
  flowRateDays: number;        // derived rate (days per foot of rise) for the interval
  intervalMs?: number;         // gap to the prior pull (ms); derived if omitted
  topLevelFeet?: number;       // measured tank top level at this pull
  priorTopLevelFeet?: number;  // prior pull's top level (for level-jump / haul match)
  bblsTaken?: number;          // haul volume on this pull
  bblPerFoot?: number;         // barrels per foot (level <-> bbls conversion)
  wellDown?: boolean;
  enteredAtMs?: number;        // when entered/edited (late-entry timing quality)
  jobType?: string;            // commodity hauled — NOT a washout marker
}

export type ValidityReason =
  | 'ok'
  | 'impossible_rate'          // rate <= 0, non-finite, or >= max sanity cap
  | 'corrupt_timing'           // no parseable time / non-positive interval
  | 'short_gap_duplicate'      // interval below the minimum plausible gap
  | 'unexplained_level_jump'   // ~7-ft top-level change with no explaining haul
  | 'missing_haul';            // haul required but missing/unknown

export interface ValidityVerdict {
  valid: boolean;
  reason: ValidityReason;
}

export type ConfidenceTier =
  | 'normal'
  | 'slightlyUnusual'
  | 'knownDisturbance'
  | 'highlyQuestionable'
  | 'invalid';

export interface ConfidenceResult {
  weight: number;              // final learning weight in [0,1]
  tier: ConfidenceTier;        // consistency tier chosen (pre-timing-modifier)
  validity: ValidityVerdict;
  timingFactor: number;        // multiplicative timing-quality modifier applied
  regimeAccepted: boolean;     // confidence restored by change-point acceptance
}

export interface AfrV2Result {
  /** underlying confidence-weighted AFR (days/ft). */
  afr: number;
  /** effective forecast (days/ft) — equals afr unless an enabled washout window
   *  with a qualified ON nudges it (currently always === afr; window gated). */
  effectiveForecast: number;
  /** per-interval diagnostics (tests/replay only — never persisted). */
  perInterval: Array<{ key: string; timestamp: number; rate: number } & ConfidenceResult>;
  /** true when a genuine sustained regime change was accepted this computation. */
  regimeAccepted: boolean;
}

export type ActivationReason = 'invalid' | 'anomaly' | 'change_point' | 'event';

/** Hybrid result: stable/ordinary data passes through v1 byte-identically;
 *  confidence weighting engages ONLY when a proven condition activates it. */
export interface AfrHybridResult extends AfrV2Result {
  /** 'v1_passthrough' when no condition activated (afr === computeAfrV1FromRates);
   *  'v2_active' when confidence weighting engaged. */
  mode: 'v1_passthrough' | 'v2_active';
  activated: boolean;
  activationReasons: ActivationReason[];
}
