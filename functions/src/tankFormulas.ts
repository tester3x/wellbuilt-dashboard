// tankFormulas.ts — pure tank-derived / recovery / flow scalar formulas,
// extracted VERBATIM from processIncomingPull. The tank-after conversion uses
// the canonical 20 bbl/ft/tank (bblsTaken / 20 / tanks * 12), recovery is
// max(0, top - prevBottom), and flow rate is (timeDif/recovery)*12 with the
// >=365 days/ft anomaly guard → 0. Preserved exactly; do not approximate.

export function computeTankTopInches(tankLevelFeet: unknown): number {
  return (parseFloat(String(tankLevelFeet)) || 0) * 12;
}

export function computeBblsInInches(bblsTaken: number, tanks: number): number {
  return bblsTaken > 0 ? (bblsTaken / 20 / tanks) * 12 : 0;
}

export function computeTankAfterInches(tankTopInches: number, bblsTaken: number, tanks: number): number {
  return tankTopInches - computeBblsInInches(bblsTaken, tanks);
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
