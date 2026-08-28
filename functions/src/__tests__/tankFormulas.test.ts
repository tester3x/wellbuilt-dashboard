// Golden pins for the tank-derived / recovery / flow formulas. Tank-after uses
// the well's RESOLVED TOTAL bblPerFoot (not a universal 20). Cases cover the
// three real config shapes found in the audit.
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

  test('tank after uses resolved bblPerFoot (top − (bbls/bblPerFoot)*12)', () => {
    // 20 bbl/ft, one tank (Gabriel 5): 158,145,20 → 71 ; 84,60,20 → 48
    expect(computeTankAfterInches(158, 145, 20)).toBe(71);
    expect(computeTankAfterInches(84, 60, 20)).toBe(48);
    expect(computeBblsInInches(145, 20)).toBe(87);
    // NON-20 single tank (Predator 1 = 25): 120,50,25 → 120 - (50/25)*12 = 96
    expect(computeTankAfterInches(120, 50, 25)).toBe(96);
    // multiple tanks — total bblPerFoot=40 (Atlas 1, 2 tanks): 120,60,40 → 120 - (60/40)*12 = 102
    expect(computeTankAfterInches(120, 60, 40)).toBe(102);
    // multiple tanks — non-20 total (Daredevil 1 = 200, 6 tanks): 240,100,200 → 240 - (100/200)*12 = 234
    expect(computeTankAfterInches(240, 100, 200)).toBe(234);
    // guards
    expect(computeBblsInInches(0, 20)).toBe(0);   // zero bbls
    expect(computeBblsInInches(50, 0)).toBe(0);   // no bblPerFoot → 0 (caller resolves a real value)
  });

  test('recovery = max(0, top − prevBottom); no prev → 0', () => {
    expect(computeRecoveryInches(84, 71)).toBe(13);
    expect(computeRecoveryInches(158, 66)).toBe(92);
    expect(computeRecoveryInches(50, 60)).toBe(0);
    expect(computeRecoveryInches(84, 0)).toBe(0);
  });

  test('flow rate (days/ft) with the >=365 anomaly guard', () => {
    expect(computeFlowRateDays(0.9637, 92)).toBeCloseTo(0.125700, 5);
    expect(computeFlowRateDays(0.2763, 13)).toBeCloseTo(0.255046, 5);
    expect(computeFlowRateDays(0, 13)).toBe(0);
    expect(computeFlowRateDays(0.5, 0)).toBe(0);
    expect(computeFlowRateDays(400, 1)).toBe(0); // >=365 days/ft rejected
  });
});
