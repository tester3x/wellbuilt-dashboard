/**
 * AFR v2 — AUTOMATIC event-free transient detection. No washout labels are ever
 * supplied to computeAfrAuto (intervals + policy only). Each well judged against
 * its OWN robust history. Synthetic data only.
 */
import { AFR_V2_POLICY } from '../afr/afrV2Policy';
import { computeAfrAuto, type AutoReason } from '../afr/afrAutoTransient';
import { computeAfrV1FromRates } from '../afr/afrV1';
import type { AfrInterval } from '../afr/afrTypes';

const P = AFR_V2_POLICY;
const DAY = 86400000;
const T0 = Date.parse('2026-08-01T12:00:00Z');

/** Build daily intervals from a rate array; overrides applied per-index via `over`. */
function series(rates: number[], over: Record<number, Partial<AfrInterval>> = {}, startMs = T0): AfrInterval[] {
  return rates.map((r, i) => ({
    key: `k${i}`, timestamp: startMs + i * DAY, flowRateDays: r, intervalMs: DAY, ...(over[i] || {}),
  }));
}
const reasons = (rates: number[], over?: Record<number, Partial<AfrInterval>>): AutoReason[] =>
  computeAfrAuto(series(rates, over), P).perInterval.map((p) => p.reason);

describe('computeAfrAuto — automatic per-well transient detection (no events)', () => {
  const STABLE = [0.50, 0.49, 0.51, 0.50, 0.48, 0.52, 0.50]; // tight ~0.50 band

  it('#11 frozen normal period: stable data is NOT worse than v1 baseline (close, no inflation)', () => {
    const r = computeAfrAuto(series(STABLE), P);
    expect(r.mode).toBe('stable');
    expect(r.regimeAccepted).toBe(false);
    expect(r.perInterval.every((p) => p.reason === 'stable')).toBe(true);
    // Not worse than the accepted v1 baseline on clean data.
    const v1 = computeAfrV1FromRates(STABLE);
    expect(Math.abs(r.afr - v1) / v1).toBeLessThan(0.1);
  });

  it('#3 one isolated high spike → inferred-transient, then returning-to-baseline; AFR not inflated', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 1.60, 0.50, 0.49, 0.51]; // spike at idx4
    const r = computeAfrAuto(series(rates), P);
    const rs = r.perInterval.map((p) => p.reason);
    expect(rs[4]).toBe('inferred-transient');
    expect(rs[5]).toBe('returning-to-baseline');   // first in-band after spike
    expect(rs[6]).toBe('stable');                   // 2nd consecutive in-band → exited
    // spike retained (valid) but near-silent → AFR stays near the ~0.50 baseline
    expect(r.perInterval[4].valid).toBe(true);
    expect(r.perInterval[4].weight).toBeLessThanOrEqual(P.autoTransient.transientWeight);
    expect(r.afr).toBeLessThan(0.75);               // never inflated toward 1.6
  });

  it('#4 spike then 1–3 erratic high/low days are all suppressed until a clean return', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 1.70, 0.15, 1.40, 0.20, 0.50, 0.49];
    const rs = reasons(rates);
    expect(rs[4]).toBe('inferred-transient');
    // erratic high/low during the transient stay suppressed (not stable, not regime)
    for (const i of [5, 6, 7]) expect(['inferred-transient', 'returning-to-baseline']).toContain(rs[i]);
    expect(rs.slice(5, 8).includes('accepted-regime-change')).toBe(false);
    const r = computeAfrAuto(series(rates), P);
    expect(r.afr).toBeGreaterThan(0.3);
    expect(r.afr).toBeLessThan(0.8); // baseline held despite the erratic middle
  });

  it('#6 genuine sustained INCREASE (3+ consistent) → accepted-regime-change, AFR adapts up', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 1.20, 1.22, 1.18, 1.21]; // sustained ~1.2
    const r = computeAfrAuto(series(rates), P);
    expect(r.regimeAccepted).toBe(true);
    expect(r.mode).toBe('regime_changed');
    expect(r.perInterval.some((p) => p.reason === 'accepted-regime-change')).toBe(true);
    expect(r.afr).toBeGreaterThan(0.9); // adapted toward the new ~1.2 regime
  });

  it('#6 genuine sustained DECREASE (3+ consistent) → accepted-regime-change, AFR adapts down', () => {
    const rates = [1.20, 1.18, 1.22, 1.20, 0.40, 0.42, 0.38, 0.41];
    const r = computeAfrAuto(series(rates), P);
    expect(r.regimeAccepted).toBe(true);
    expect(r.afr).toBeLessThan(0.9);
  });

  it('#6 distinguishes transient (reverts) from regime (persists): a 2-day spike does NOT accept a regime', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 1.30, 1.28, 0.50, 0.49];
    const r = computeAfrAuto(series(rates), P);
    expect(r.regimeAccepted).toBe(false); // only 2 off-trend then returned → transient
  });

  it('#5/#8 repeated irregular washouts: each spike restarts transient independently; AFR stays near baseline', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 1.60, 0.50, 0.49, 1.70, 0.50, 0.51, 1.55, 0.50, 0.49];
    const r = computeAfrAuto(series(rates), P);
    const rs = r.perInterval.map((p) => p.reason);
    expect(rs[4]).toBe('inferred-transient');
    expect(rs[7]).toBe('inferred-transient');   // fresh spike restarts transient
    expect(rs[10]).toBe('inferred-transient');
    expect(r.regimeAccepted).toBe(false);
    expect(r.afr).toBeLessThan(0.8);
  });

  it('#6 bounded expiry: an unending one-sided-but-inconsistent disturbance cannot suppress forever', () => {
    // off-trend but NOT mutually consistent (wild high values) → never a clean
    // regime; must expire after maxTransientIntervals rather than suppress forever.
    const rates = [0.50, 0.49, 0.51, 0.50, 1.6, 2.4, 1.2, 3.0, 1.8, 2.6, 1.4];
    const r = computeAfrAuto(series(rates), P);
    const states = r.perInterval.map((p) => p.state);
    expect(states[states.length - 1]).not.toBe('TRANSIENT'); // exited (expiry or regime)
  });

  it('#7 dead/very-low well: small absolute wobble is NOT a false transient (MAD floor)', () => {
    const rates = [0.02, 0.018, 0.022, 0.02, 0.05, 0.02, 0.019]; // 0.05 is 2.5x but tiny absolute
    const rs = reasons(rates);
    expect(rs[4]).toBe('stable');                 // absorbed, not flagged
    expect(rs.includes('inferred-transient')).toBe(false);
    // but a REAL spike on a dead well IS caught
    const rs2 = reasons([0.02, 0.018, 0.022, 0.02, 0.40, 0.02]);
    expect(rs2[4]).toBe('inferred-transient');
  });

  it('#8 long gap with a legitimate in-band rate is stable (long gap alone is not a disturbance)', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 0.50];
    const over = { 4: { intervalMs: 9 * DAY } }; // long gap, normal rate
    const rs = reasons(rates, over);
    expect(rs[4]).toBe('stable');
  });

  it('#10/#12 validity: short-gap duplicate, impossible rate, and unexplained level jump are invalid (kept, weight 0, isolated)', () => {
    const r = computeAfrAuto(series(
      [0.50, 0.49, 0.51, 0.50, 0.50, 0.50, 0.50],
      {
        4: { intervalMs: 2 * 60 * 1000 },                     // 2-min → short_gap_duplicate
        5: { flowRateDays: -3 },                              // impossible
        6: { topLevelFeet: 2, priorTopLevelFeet: 10, bblsTaken: 5, bblPerFoot: 20 }, // ~8ft drop, haul explains 0.25ft → unexplained
      },
    ), P);
    expect(r.perInterval[4].valid).toBe(false);
    expect(r.perInterval[4].validityReason).toBe('short_gap_duplicate');
    expect(r.perInterval[5].validityReason).toBe('impossible_rate');
    expect(r.perInterval[6].validityReason).toBe('unexplained_level_jump');
    for (const i of [4, 5, 6]) { expect(r.perInterval[i].reason).toBe('invalid'); expect(r.perInterval[i].weight).toBe(0); }
    // invalid rows do not poison the baseline: AFR stays ~0.50
    expect(Math.abs(r.afr - 0.50)).toBeLessThan(0.1);
  });

  it('#12 corrupt Gabriel 4 style data (repeated impossible/unexplained) is isolated, never used to claim change', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 606, 0.50, 10.08, 0.49];
    const r = computeAfrAuto(series(rates), P);
    expect(r.perInterval[4].valid).toBe(false); // 606 >= maxFlowRateDays
    expect(r.regimeAccepted).toBe(false);
    expect(r.afr).toBeLessThan(1.0);            // corrupt values excluded, not adopted
  });

  it('#10 deterministic recompute: same intervals → identical result; edit/delete recompute cleanly', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 1.60, 0.50, 0.49];
    const a = computeAfrAuto(series(rates), P);
    const b = computeAfrAuto(series(rates), P);
    expect(b).toEqual(a);                                   // pure/deterministic
    // "delete" the spike → recompute has no transient at all
    const deleted = series(rates).filter((_, i) => i !== 4);
    const d = computeAfrAuto(deleted, P);
    expect(d.perInterval.some((p) => p.reason === 'inferred-transient')).toBe(false);
    // "edit" the spike down to in-band → also no transient
    const edited = computeAfrAuto(series([0.50, 0.49, 0.51, 0.50, 0.50, 0.50, 0.49]), P);
    expect(edited.perInterval.some((p) => p.reason === 'inferred-transient')).toBe(false);
  });

  it('#1/#2 per-well independence: a disturbance in one well never affects another (Wed vs Fri)', () => {
    // Well A disturbed "Wednesday" (idx4); Well B normal until "Friday" (idx6).
    const wellA = computeAfrAuto(series([0.50, 0.49, 0.51, 0.50, 1.60, 0.50, 0.49]), P);
    const wellB = computeAfrAuto(series([0.60, 0.59, 0.61, 0.60, 0.59, 0.61, 1.80]), P);
    // A's Wednesday spike is transient; B is completely stable through Thursday.
    expect(wellA.perInterval[4].reason).toBe('inferred-transient');
    expect(wellB.perInterval.slice(0, 6).every((p) => p.reason === 'stable')).toBe(true);
    expect(wellB.perInterval[6].reason).toBe('inferred-transient'); // B's own Friday spike, independent
    // computeAfrAuto has no cross-well input — independence is structural.
    expect(wellA.afr).not.toBe(wellB.afr);
  });

  it('#13 auditable reasons: every interval carries exactly one reason from the allowed set', () => {
    const allowed = new Set<AutoReason>(['stable', 'timing-low-confidence', 'inferred-transient', 'returning-to-baseline', 'accepted-regime-change', 'invalid']);
    const r = computeAfrAuto(series([0.50, 0.49, 0.51, 0.50, 1.60, 0.50, 0.49, 1.2, 1.22, 1.19, 1.21]), P);
    for (const p of r.perInterval) expect(allowed.has(p.reason)).toBe(true);
  });

  it('timing-low-confidence: a short-gap-but-valid pull is down-weighted with the timing reason, not dropped', () => {
    const rates = [0.50, 0.49, 0.51, 0.50, 0.50];
    const over = { 4: { intervalMs: 20 * 60 * 1000 } }; // 20 min: > 5-min min (valid) but < 60-min short-gap
    const r = computeAfrAuto(series(rates, over), P);
    expect(r.perInterval[4].valid).toBe(true);
    expect(r.perInterval[4].reason).toBe('timing-low-confidence');
    expect(r.perInterval[4].weight).toBeLessThan(1);
  });

  it('#12 ON is never consulted: computeAfrAuto takes only intervals + policy (no ON/washout input)', () => {
    // Signature guard — there is no ON/event parameter; detection is intrinsic.
    expect(computeAfrAuto.length).toBe(2);
  });
});
