// Golden-fixture parity pins for the AFR/flow formulas extracted VERBATIM from
// processIncomingPull.calculateAFR. These lock the exact outputs; combined with
// the full functions suite staying green (behavior-preserving extraction), they
// prove the pure builders match the production formulas. Do not "fix" a golden
// value without a corresponding, intentional formula change.
import {
  computeAFRFromRates, filterAnomalies, median, getFlowRateAnomalyLevel,
  ANOMALY_RATIO, ITREVIEW_RATIO, EMA_ALPHA,
} from '../pullFormulas';

describe('computeAFRFromRates — golden pins', () => {
  test('fewer than 3 rates → last value (no smoothing)', () => {
    expect(computeAFRFromRates([])).toBe(0);
    expect(computeAFRFromRates([0.13])).toBe(0.13);
    expect(computeAFRFromRates([0.13, 0.15])).toBe(0.15);
  });

  test('EMA(alpha=0.4) over a clean 5-rate window', () => {
    expect(computeAFRFromRates([0.10, 0.12, 0.11, 0.13, 0.12])).toBeCloseTo(0.118368, 9);
  });

  test('a Tier-2 anomaly (5.0) is excluded before EMA', () => {
    expect(computeAFRFromRates([0.10, 0.11, 0.12, 0.11, 5.0, 0.13])).toBeCloseTo(0.118144, 9);
  });

  test('sustained step up → median of last 3', () => {
    expect(computeAFRFromRates([0.10, 0.10, 0.10, 0.30, 0.31, 0.32])).toBeCloseTo(0.3104, 9);
  });
});

describe('filterAnomalies — golden pins', () => {
  test('excludes the 2x+ outlier', () => {
    expect(filterAnomalies([0.10, 0.11, 0.12, 0.11, 5.0, 0.13])).toEqual([0.1, 0.11, 0.12, 0.11, 0.13]);
  });
  test('regime shift reseeds from the rejection run', () => {
    expect(filterAnomalies([0.10, 0.10, 0.10, 0.30, 0.31, 0.32, 0.33])).toEqual([0.3, 0.31, 0.32, 0.33]);
  });
  test('fewer than 3 → unchanged', () => {
    expect(filterAnomalies([0.2, 0.9])).toEqual([0.2, 0.9]);
  });
});

describe('median + anomaly level + constants', () => {
  test('median odd/even', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  test('anomaly level tiers', () => {
    expect(getFlowRateAnomalyLevel(0.1, 0.1)).toBe(0);   // normal
    expect(getFlowRateAnomalyLevel(0.16, 0.1)).toBe(1);  // 1.6x → IT review
    expect(getFlowRateAnomalyLevel(0.25, 0.1)).toBe(2);  // 2.5x → anomaly
    expect(getFlowRateAnomalyLevel(0.1, 0)).toBe(0);     // guard
  });
  test('constants pinned', () => {
    expect([ANOMALY_RATIO, ITREVIEW_RATIO, EMA_ALPHA]).toEqual([2.0, 1.5, 0.4]);
  });
});
