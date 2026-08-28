// tankFormulas.ts — pure tank-derived / recovery / flow scalar formulas.
//
// Tank-after uses the well's RESOLVED bblPerFoot (the TOTAL bbl/ft across all
// tanks, per well_config): tankAfterInches = tankTop - (bblsTaken / bblPerFoot)
// * 12. Audit (82 wells): bblPerFoot is total — 40/2-tank, 60/3-tank all = 20
// per tank, but 25/1-tank, 66.67/2, 67.27/2, 200/6 are genuinely non-20 wells.
// The processor's old hardcoded /20/tanks was wrong for those; this matches the
// EDIT path, which already divides by the resolved bblPerFoot. The 20 is NOT a
// universal constant — callers resolve `Number(config.bblPerFoot) > 0 ?
// config.bblPerFoot : 20 * tanks` (the existing edit-path fallback contract;
// see index.ts). recovery = max(0, top - prevBottom); flow = (timeDif/recovery)
// *12 with the >=365 days/ft anomaly guard → 0.

export function computeTankTopInches(tankLevelFeet: unknown): number {
  return (parseFloat(String(tankLevelFeet)) || 0) * 12;
}

/** bblsTaken converted to inches of drop, using the RESOLVED total bblPerFoot. */
export function computeBblsInInches(bblsTaken: number, bblPerFoot: number): number {
  return bblsTaken > 0 && bblPerFoot > 0 ? (bblsTaken / bblPerFoot) * 12 : 0;
}

export function computeTankAfterInches(tankTopInches: number, bblsTaken: number, bblPerFoot: number): number {
  return tankTopInches - computeBblsInInches(bblsTaken, bblPerFoot);
}

export function computeRecoveryInches(tankTopInches: number, prevTankAfterInches: number): number {
  return prevTankAfterInches > 0 ? Math.max(0, tankTopInches - prevTankAfterInches) : 0;
}

/** Flow rate (days per foot): (timeDif/recovery)*12; >=365 days/ft is rejected
 *  as anomalous → 0 (matches the windowBblsPerDay safeguard). */
export function computeFlowRateDays(timeDifDays: number, recoveryInches: number): number {
  if (recoveryInches > 0 && timeDifDays > 0) {
    const flowRateDays = (timeDifDays / recoveryInches) * 12;
    return flowRateDays >= 365 ? 0 : flowRateDays;
  }
  return 0;
}
