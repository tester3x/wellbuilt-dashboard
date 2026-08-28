// Golden pins for the tank-derived / recovery / flow formulas extracted verbatim
// from processIncomingPull (canonical 20 bbl/ft/tank; >=365 days/ft guard).
import {
  computeTankTopInches, computeBblsInInches, computeTankAfterInches,
  computeRecoveryInches, computeFlowRateDays,
} from '../tankFormulas';

describe('tank formulas — golden pins', () => {
  test('tank top from feet', () => {
    expect(computeTankTopInches(7)).toBe(84);
    expect(computeTankTopInches('13.166666666666666')).toBeCloseTo(158, 6);
    expect(computeTankTopInches(undefined)).toBe(0);
  });

  test('tank after = top − (bbls/20/tanks)*12 (Gabriel 1:01 PM: 158,145,1 → 71)', () => {
    expect(computeTankAfterInches(158, 145, 1)).toBe(71);
    expect(computeTankAfterInches(84, 60, 1)).toBe(48);
    expect(computeBblsInInches(145, 1)).toBe(87);
    expect(computeBblsInInches(0, 1)).toBe(0); // zero bbls → 0
  });

  test('recovery = max(0, top − prevBottom); no prev → 0', () => {
    expect(computeRecoveryInches(84, 71)).toBe(13);   // Gabriel PM
    expect(computeRecoveryInches(158, 66)).toBe(92);  // Gabriel 1:01 PM
    expect(computeRecoveryInches(50, 60)).toBe(0);    // top below prev bottom → 0
    expect(computeRecoveryInches(84, 0)).toBe(0);     // no prior bottom
  });

  test('flow rate (days/ft) with the >=365 anomaly guard', () => {
    expect(computeFlowRateDays(0.9637, 92)).toBeCloseTo(0.125700, 5); // ≈3:01/ft
    expect(computeFlowRateDays(0.2763, 13)).toBeCloseTo(0.255046, 5); // Gabriel PM ≈6:07/ft
    expect(computeFlowRateDays(0, 13)).toBe(0);       // no elapsed
    expect(computeFlowRateDays(0.5, 0)).toBe(0);      // no recovery
    expect(computeFlowRateDays(400, 1)).toBe(0);      // >=365 days/ft → rejected
  });
});
