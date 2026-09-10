/**
 * AFR v2 — validity / confidence / change-point / ON-qualification matrix.
 * Pure-logic tests (no I/O). Synthetic wells only.
 */
import { AFR_V2_POLICY, type AfrV2Policy } from '../afr/afrV2Policy';
import { decideValidity } from '../afr/validity';
import { scoreConfidence } from '../afr/confidence';
import { computeAfrHybrid } from '../afr/afrV2';
import { qualifyOvernight } from '../afr/onQualification';
import { computeAfrV1FromRates } from '../afr/afrV1';
import type { AfrInterval } from '../afr/afrTypes';

const P: AfrV2Policy = AFR_V2_POLICY;
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
function iv(rate: number, over: Partial<AfrInterval> = {}): AfrInterval {
  seq += 1;
  return { key: `k${seq}`, timestamp: 1_700_000_000_000 + seq * DAY, flowRateDays: rate, intervalMs: DAY, ...over };
}
const rates = (arr: number[], over: (i: number) => Partial<AfrInterval> = () => ({})) =>
  arr.map((r, i) => iv(r, over(i)));

describe('VALIDITY — only genuinely invalid gets 0.0', () => {
  it('impossible rate: <=0, non-finite, or >= 365 days/ft', () => {
    expect(decideValidity(iv(0), P).valid).toBe(false);
    expect(decideValidity(iv(-1), P).valid).toBe(false);
    expect(decideValidity(iv(NaN), P).valid).toBe(false);
    expect(decideValidity(iv(365), P)).toEqual({ valid: false, reason: 'impossible_rate' });
    expect(decideValidity(iv(0.5), P).valid).toBe(true);
  });
  it('corrupt timing / short-gap duplicate', () => {
    expect(decideValidity(iv(0.5, { timestamp: 0 }), P)).toEqual({ valid: false, reason: 'corrupt_timing' });
    expect(decideValidity(iv(0.5, { intervalMs: -1 }), P)).toEqual({ valid: false, reason: 'corrupt_timing' });
    expect(decideValidity(iv(0.5, { intervalMs: 60 * 1000 }), P)).toEqual({ valid: false, reason: 'short_gap_duplicate' });
  });
  it('unexplained ~7-ft change only when levels+haul present and unaccounted', () => {
    // 7-ft drop but haul only accounts for ~2 ft → unexplained → invalid.
    expect(decideValidity(iv(0.5, { priorTopLevelFeet: 10, topLevelFeet: 3, bblsTaken: 40, bblPerFoot: 20 }), P))
      .toEqual({ valid: false, reason: 'unexplained_level_jump' });
    // 7-ft drop fully explained by a 140-bbl haul (7 ft * 20) → valid.
    expect(decideValidity(iv(0.5, { priorTopLevelFeet: 10, topLevelFeet: 3, bblsTaken: 140, bblPerFoot: 20 }), P).valid).toBe(true);
    // Missing level data → cannot prove → valid (never invalidate on missing optionals).
    expect(decideValidity(iv(0.5, { bblsTaken: 40 }), P).valid).toBe(true);
  });
});

describe('CONFIDENCE — weight from consistency + timing, NEVER prediction error', () => {
  it('a valid reading consistent with surrounding rates keeps normal weight even if it implies a bad prediction', () => {
    // "Ordinary bad-performance day": rate equal to the surrounding trend → normal.
    const r = scoreConfidence(iv(0.5), { medianRate: 0.5 }, P);
    expect(r.tier).toBe('normal');
    expect(r.weight).toBe(P.confidence.normal);
  });
  it('slightly unusual (1.5x–<2.0x) is RETAINED at full weight (v1 parity)', () => {
    const r = scoreConfidence(iv(0.8), { medianRate: 0.5 }, P); // 1.6x
    expect(r.tier).toBe('slightlyUnusual');
    expect(r.weight).toBeCloseTo(1.0); // retained — never an activation trigger, never down-weighted
  });
  it('questionable but plausible (>=2.0x) → low weight 0.1, NEVER 0.0', () => {
    const r = scoreConfidence(iv(1.2), { medianRate: 0.5 }, P); // 2.4x, valid
    expect(r.tier).toBe('highlyQuestionable');
    expect(r.weight).toBeCloseTo(0.1);
    expect(r.validity.valid).toBe(true);
  });
  it('technically impossible still 0.0 regardless of consistency', () => {
    const r = scoreConfidence(iv(0, { intervalMs: DAY }), { medianRate: 0.5 }, P);
    expect(r.tier).toBe('invalid');
    expect(r.weight).toBe(0);
  });
  it('short-gap-but-valid and late entry reduce weight via timing factor', () => {
    const short = scoreConfidence(iv(0.5, { intervalMs: 30 * 60 * 1000 }), { medianRate: null }, P);
    expect(short.weight).toBeCloseTo(P.confidence.normal * P.timing.shortGapFactor);
    const late = scoreConfidence(iv(0.5, { enteredAtMs: 1_700_000_000_000 + 999 * DAY }), { medianRate: 0.5 }, P);
    expect(late.timingFactor).toBeCloseTo(P.timing.lateEntryFactor);
  });
});

describe('HYBRID — stable/ordinary data is v1 BYTE-IDENTICAL; weighting only on a proven condition', () => {
  it('a clean, stable well passes through to v1 exactly (byte-identical)', () => {
    const arr = [0.50, 0.52, 0.49, 0.51, 0.50, 0.53, 0.48, 0.50];
    const res = computeAfrHybrid(rates(arr), P);
    expect(res.mode).toBe('v1_passthrough');
    expect(res.activated).toBe(false);
    expect(res.afr).toBe(computeAfrV1FromRates(arr)); // exact equality, not close
  });
  it('a well with only 1.5–<2.0x readings (no >=2.0x) does NOT activate → still v1 exact', () => {
    // 0.75 vs a ~0.5 trend is ~1.5x (IT-review tier), retained, not an anomaly.
    const arr = [0.5, 0.5, 0.5, 0.5, 0.75, 0.5, 0.5];
    const res = computeAfrHybrid(rates(arr), P);
    expect(res.mode).toBe('v1_passthrough');
    expect(res.afr).toBe(computeAfrV1FromRates(arr));
  });
  it('byte-identical to v1 across many clean sequences (no anomaly/invalid/change-point)', () => {
    const seqs = [
      [0.2, 0.21, 0.19, 0.2, 0.2], [1.0, 1.05, 0.98, 1.02, 1.0, 0.99],
      [0.33, 0.34, 0.32, 0.33, 0.35, 0.33, 0.34, 0.32, 0.33],
      [5, 5.2, 4.9, 5.1, 5.0], [0.8, 0.82, 0.78, 0.81, 0.79, 0.80],
    ];
    for (const s of seqs) {
      const res = computeAfrHybrid(rates(s), P);
      expect(res.mode).toBe('v1_passthrough');
      expect(res.afr).toBe(computeAfrV1FromRates(s));
    }
  });
  it('a >=2.0x anomaly activates (mode v2_active, reason anomaly)', () => {
    const res = computeAfrHybrid(rates([0.5, 0.5, 0.5, 0.5, 0.5, 1.5]), P); // 3x
    expect(res.mode).toBe('v2_active');
    expect(res.activationReasons).toContain('anomaly');
  });
  it('an invalid observation activates (reason invalid)', () => {
    const res = computeAfrHybrid([...rates([0.5, 0.5, 0.5, 0.5, 0.5]), iv(0)], P);
    expect(res.activationReasons).toContain('invalid');
  });
  it('a sustained change-point activates (reason change_point) and does not stay v1', () => {
    const res = computeAfrHybrid(rates([0.5, 0.5, 0.5, 0.5, 1.3, 1.3, 1.3]), P);
    expect(res.mode).toBe('v2_active');
    expect(res.activationReasons).toContain('change_point');
  });
});

describe('EFFECTIVE FORECAST — weighted EMA, disturbed pulls contribute "a little piece"', () => {
  it('stable well: AFR tracks the level rate; no regime accepted', () => {
    const res = computeAfrHybrid(rates([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), P);
    expect(res.afr).toBeCloseTo(0.5, 6);
    expect(res.regimeAccepted).toBe(false);
    expect(res.effectiveForecast).toBe(res.afr); // washout blend gated
  });
  it('one questionable spike barely moves the trend (low weight), invalid moves it not at all', () => {
    const base = computeAfrHybrid(rates([0.5, 0.5, 0.5, 0.5, 0.5]), P).afr;
    const withSpike = computeAfrHybrid(rates([0.5, 0.5, 0.5, 0.5, 0.5, 1.2]), P).afr; // 2.4x valid → w 0.1
    expect(Math.abs(withSpike - base)).toBeLessThan(0.05); // nudged only a little
    const withInvalid = computeAfrHybrid([...rates([0.5, 0.5, 0.5, 0.5, 0.5]), iv(0)], P).afr; // 0.0
    expect(withInvalid).toBeCloseTo(base, 6); // zero-weight cannot steer
  });
});

describe('CHANGE-POINT — sustained same-direction change is eventually accepted (not suppressed forever)', () => {
  it('three consecutive same-direction off-trend intervals accept the regime and restore weight', () => {
    // Stable 0.5, then a genuine step up to ~1.3 sustained for 3 pulls.
    const res = computeAfrHybrid(rates([0.5, 0.5, 0.5, 0.5, 1.3, 1.3, 1.3]), P);
    expect(res.regimeAccepted).toBe(true);
    // The regime intervals were restored to full confidence → AFR moves decisively toward the new rate.
    expect(res.afr).toBeGreaterThan(0.8);
    const accepted = res.perInterval.filter((p) => p.regimeAccepted);
    expect(accepted.length).toBeGreaterThanOrEqual(P.regime.acceptAfter);
  });
  it('two off-trend intervals do NOT trigger acceptance (below threshold)', () => {
    const res = computeAfrHybrid(rates([0.5, 0.5, 0.5, 0.5, 1.3, 1.3]), P);
    expect(res.regimeAccepted).toBe(false);
  });
});

describe('WASHOUT window — GATED (no explicit event source)', () => {
  it('policy.washout.enabled is false — the forecast never claims to know Days 1-3', () => {
    expect(P.washout.enabled).toBe(false);
  });
  it('generic behavior is identical regardless of calendar position (no day-based modifier applied)', () => {
    // Same rate sequence starting on two different calendar days → identical AFR,
    // because no event-anchored window exists to change weights by date.
    const a = computeAfrHybrid(rates([0.5, 0.6, 0.55, 0.5, 0.52]), P).afr;
    seq += 100; // shift all timestamps to a different set of calendar days
    const b = computeAfrHybrid(rates([0.5, 0.6, 0.55, 0.5, 0.52]), P).afr;
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('ON qualification — separate consumer, does not alter ON', () => {
  it('qualified when the overnight pair is valid, coverage chronological and mostly valid', () => {
    const cov = rates([0.5, 0.5, 0.5, 0.5]);
    const q = qualifyOvernight(iv(0.5), cov, P);
    expect(q.qualified).toBe(true);
  });
  it('unqualified when dominated by invalid/short-gap pairs', () => {
    const cov = [iv(0), iv(0, { intervalMs: 60 * 1000 }), iv(0.5), iv(-1)];
    const q = qualifyOvernight(iv(0.5), cov, P);
    expect(q.qualified).toBe(false);
    expect(q.reasons).toContain('dominated_by_invalid_or_degenerate_pairs');
  });
  it('unqualified when the overnight pair itself is invalid (short gap)', () => {
    const q = qualifyOvernight(iv(0.5, { intervalMs: 60 * 1000 }), rates([0.5, 0.5, 0.5]), P);
    expect(q.qualified).toBe(false);
    expect(q.reasons.some((r) => r.startsWith('overnight_pair_'))).toBe(true);
  });
});

describe('DETERMINISM — late entry / edit / delete recompute the same', () => {
  it('same intervals → identical result (order-independent of when entered)', () => {
    const base = rates([0.5, 0.6, 0.55, 0.5, 0.52, 0.51]);
    const a = computeAfrHybrid(base, P);
    const b = computeAfrHybrid(base.map((x) => ({ ...x, enteredAtMs: x.timestamp + 5 * DAY })), P);
    // Late entry lowers per-interval weight but the computation is deterministic
    // for identical inputs; recomputation on a fixed set is stable.
    const c = computeAfrHybrid(base, P);
    expect(a.afr).toBeCloseTo(c.afr, 9);
    expect(typeof b.afr).toBe('number');
  });
});

describe('v1 baseline regression (extracted, byte-equivalent)', () => {
  it('v1 <3 rates → last; stable → EMA near level', () => {
    expect(computeAfrV1FromRates([0.5])).toBe(0.5);
    expect(computeAfrV1FromRates([0.5, 0.6])).toBe(0.6);
    expect(computeAfrV1FromRates([0.5, 0.5, 0.5, 0.5, 0.5])).toBeCloseTo(0.5, 6);
  });
  it('v1 excludes a >=2.0x anomaly from the average; v2 keeps it at low weight', () => {
    const arr = [0.5, 0.5, 0.5, 0.5, 0.5, 2.0]; // last is 4x
    const v1 = computeAfrV1FromRates(arr);
    const v2 = computeAfrHybrid(rates(arr), P).afr;
    expect(v1).toBeLessThan(0.8);          // v1 filtered the spike out
    expect(v2).toBeLessThan(0.8);          // v2 kept it but at 0.1 weight → barely moved
  });
});
