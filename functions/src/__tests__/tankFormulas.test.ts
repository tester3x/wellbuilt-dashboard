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

  test('tank after uses the CONFIGURED TOTAL bblPerFoot — count distinguished from geometry', () => {
    // The formula divides by the configured bank total; it never divides by tank
    // count again. Cases distinguish a standard equalized bank (total = 20×count)
    // from genuinely different geometry (total != 20×count).
    expect(computeTankAfterInches(158, 145, 20)).toBe(71);   // 20/ft, 1 tank (Gabriel 5) — Standard
    expect(computeTankAfterInches(84, 60, 20)).toBe(48);
    expect(computeBblsInInches(145, 20)).toBe(87);
    // Standard equalized banks: total = 20 × count.
    expect(computeTankAfterInches(120, 60, 40)).toBe(102);   // 40/ft, 2 tanks (Atlas 1) — Standard
    expect(computeTankAfterInches(240, 120, 120)).toBe(228); // 120/ft, 6 tanks (Thor 5) — Standard (20/tank)
    // Geometry/capacity configured: total != 20 × count.
    expect(computeTankAfterInches(120, 50, 25)).toBe(96);              // 25/ft, 1 tank (Predator 1)
    expect(computeTankAfterInches(120, 60, 66.66666666666667)).toBeCloseTo(109.2, 6); // 66.67/ft, 2 tanks (Barnstormer 3)
    expect(computeTankAfterInches(240, 100, 200)).toBe(234);          // 200/ft, 6 tanks (Daredevil 1)
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

// Phase-1 regression freeze (2026-08-29): the deployed pull path hardcoded
// bblsTaken/20/tanks and materialized Predator 1's 2026-08-28 pull with the
// wrong geometry. Pin the complete known well matrix, the exact production
// case, and the two invariants the audit contract states: the configured
// aggregate is never divided by tank count again, and unusual field readings
// are computed — never physically rejected.
describe('tank geometry — deployed-defect regression freeze', () => {
  test('Predator 1 production case 20260828_090803_Predator1_3k806o: 25/ft is correct, deployed 20/ft was wrong', () => {
    // Driver facts: top 14 ft (168 in), 140 bbl. Config: 1 tank, 25 BBL/ft total.
    expect(computeTankAfterInches(168, 140, 25)).toBeCloseTo(100.8, 6); // correct bottom (8'4.8")
    expect(computeTankAfterInches(168, 140, 20)).toBe(84);             // what production stored (7'0") — the defect
  });

  test('known well matrix: aggregate BBL/ft with authoritative tank counts', () => {
    // Standard 400-BBL 20-ft tanks contribute 20 BBL/ft each.
    expect(computeBblsInInches(20, 20 * 1)).toBe(12);   // 1 std tank → 20 total
    expect(computeBblsInInches(40, 20 * 2)).toBe(12);   // 2 equalized std tanks → 40 total
    expect(computeBblsInInches(60, 20 * 3)).toBe(12);   // 3 equalized std tanks → 60 total
    // Thor 5: 6 tanks, 120 total — standard at 20/tank.
    expect(computeBblsInInches(120, 120)).toBe(12);
    // Predator 1: 1 tank, 25 total.
    expect(computeTankAfterInches(120, 25, 25)).toBe(108);
    // Barnstormer 3: 2 tanks, 66.67 total.
    expect(computeTankAfterInches(150, 66.66666666666667, 66.66666666666667)).toBeCloseTo(138, 6);
    // Gunslinger 3 and 5: 2 tanks, 67.27 total each.
    expect(computeTankAfterInches(150, 67.27272727272727, 67.27272727272727)).toBeCloseTo(138, 6);
    expect(computeBblsInInches(134.54545454545453, 67.27272727272727)).toBeCloseTo(24, 6);
    // Daredevil 1: 6 tanks, 200 total.
    expect(computeTankAfterInches(240, 200, 200)).toBe(228);
  });

  test('the configured aggregate is NEVER divided by tank count again', () => {
    // Two equalized standard tanks: total 40. Dividing 40 by the 2 tanks again
    // (the legacy /20/tanks shape re-applied to an aggregate) would double the
    // drop. Pin that the formula consumes the total exactly once.
    const aggregateTotal = 40;
    expect(computeTankAfterInches(120, 60, aggregateTotal)).toBe(102);        // correct: 18 in drop
    expect(computeTankAfterInches(120, 60, aggregateTotal / 2)).toBe(84);     // the double-division wrong answer
  });

  test('unusual readings are computed, never physically rejected', () => {
    // A drop below zero, an enormous pull, a tiny bblPerFoot — the formulas
    // return arithmetic, they do not throw or clamp business intent away.
    expect(() => computeTankAfterInches(24, 500, 20)).not.toThrow();
    expect(computeTankAfterInches(24, 500, 20)).toBe(-276);   // caller-level policy decides review, not rejection
    expect(computeBblsInInches(19999, 20)).toBeCloseTo(11999.4, 6);
    expect(computeTankAfterInches(480, 0, 25)).toBe(480);      // zero-bbl gauge passes through
  });
});
