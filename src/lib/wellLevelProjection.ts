// wellLevelProjection — the ONE shared current-level projection used by the
// aggregate Well Status page (/mobile), the individual Well Status card (/well),
// and the Dispatch Well Queue. It reuses the proven WB‑M vc58 estimator
// (wbmLevelEstimator) and a single input resolution from a governed WellResponse,
// so all three surfaces show the identical current level from the same inputs at
// the same asOfMs. This is DERIVED DISPLAY STATE — never persisted.

import type { WellResponse } from './wells';
import {
  type EstimatorInputs,
  estimateCurrentFeet,
  formatFeetWBM,
  parseFeetDecimal,
  parseFlowMinutesPerFoot,
  isWbmDownToken,
  MIN_VALID_PULL_MS,
} from './wbmLevelEstimator.ts';

/**
 * Resolve the WB‑M estimator inputs from a governed WellResponse — the single
 * source of the last-pull baseline (lastPullBottomLevel, fallback currentLevel),
 * the authoritative pull time (lastPullDateTimeUTC, fallback timestampUTC; invalid
 * or pre-2020 rejected), flow (H:MM:SS min/foot), and the down state
 * (wellDown/isDown/down|offline|shut in). Used by classifyWell AND the pages so
 * the estimate is identical everywhere.
 */
export function wbmInputsFromWell(well: WellResponse): EstimatorInputs {
  // Baseline is ONLY the immutable raw last-pull bottom, paired with the raw pull
  // timestamp. We deliberately do NOT fall back to well.currentLevel: on the
  // governed path that is a server-side reading already advanced past the pull, so
  // pairing it with lastPullDateTimeUTC would double-count the recovery and compound
  // every tick. No baseline ⇒ the well is unavailable (never fabricated from a
  // projected value). This matches the reference builder, which anchors its estimate
  // on outgoing.lastPullBottomLevel + outgoing.lastPullDateTimeUTC (wells.ts).
  const startingBottomFeet = parseFeetDecimal(well.lastPullBottomLevel);
  const rawTs = (well.lastPullDateTimeUTC && !isNaN(Date.parse(well.lastPullDateTimeUTC))) ? Date.parse(well.lastPullDateTimeUTC)
    : (well.timestampUTC && !isNaN(Date.parse(well.timestampUTC)) ? Date.parse(well.timestampUTC) : null);
  const pullTimeMs = (rawTs != null && rawTs >= MIN_VALID_PULL_MS) ? rawTs : null;
  const flowMinutesPerFoot = parseFlowMinutesPerFoot(well.flowRate);
  const wellDown = well.wellDown === true || well.isDown === true || isWbmDownToken(well.currentLevel);
  return { startingBottomFeet, pullTimeMs, flowMinutesPerFoot, wellDown };
}

export interface WellLevelProjection {
  /** Estimated current level in decimal feet at asOfMs (capped 20), or null. */
  estFeet: number | null;
  /** WB‑M-formatted display ("7'", "7'6\"", "20'"), or '--' when unavailable. */
  estDisplay: string;
  /** A positive flow is driving a live rise (not frozen/down). */
  hasFlow: boolean;
  /** Frozen at the baseline (no flow, or well down). */
  frozen: boolean;
  /** Hit the 20' cap. */
  capped: boolean;
  /** Down / offline / shut in. */
  wellDown: boolean;
  /** False when genuinely unavailable (no baseline, or no valid timestamp and not
   *  down) — the display is '--', NEVER 0. */
  available: boolean;
}

/** Project a well's CURRENT level at a single shared asOfMs. */
export function projectWellLevel(well: WellResponse, asOfMs: number): WellLevelProjection {
  const inputs = wbmInputsFromWell(well);
  const wellDown = inputs.wellDown;
  // Unavailable (never zero): no baseline, or a live well with no valid timestamp.
  const available = inputs.startingBottomFeet != null && (wellDown || inputs.pullTimeMs != null);
  if (!available) {
    return { estFeet: null, estDisplay: '--', hasFlow: false, frozen: false, capped: false, wellDown, available: false };
  }
  const est = estimateCurrentFeet(inputs, asOfMs);
  return {
    estFeet: est.feet,
    estDisplay: formatFeetWBM(est.feet),
    hasFlow: est.hasFlow,
    frozen: est.frozen,
    capped: est.capped,
    wellDown,
    available: true,
  };
}
