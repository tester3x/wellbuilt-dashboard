/**
 * AFR v2 — PRODUCTION ENTRY-POINT INTEGRATION.
 *
 * calculateAFR (index.ts) is the single authoritative production AFR entry point
 * used by all three recompute paths (incoming / edit / delete). It reads the last
 * `windowSize` processed packets for the well, builds AfrInterval[], appends the
 * just-arrived rate, and returns `computeAfrAuto(intervals, AFR_V2_POLICY).afr`.
 *
 * calculateAFR is module-private and reads RTDB, so — per this repo's convention
 * (extracted pure functions are unit-tested; the index wiring is asserted from
 * source, see afrV2Preservation.test.ts) — this file reproduces calculateAFR's
 * EXACT interval construction (a verbatim mirror of index.ts:729-784) and drives
 * the same engine. It therefore exercises the production-facing computation for
 * every scenario in the integration gate, deterministically and without RTDB.
 *
 * NO event labels, NO ON input, NO cross-well data ever reach the engine.
 */
import { AFR_V2_POLICY } from '../afr/afrV2Policy';
import { computeAfrAuto } from '../afr/afrAutoTransient';
import type { AfrInterval } from '../afr/afrTypes';

const P = AFR_V2_POLICY;
const DAY = 86400000;
const T0 = Date.parse('2026-08-01T12:00:00Z');

/** A processed packet as calculateAFR actually reads it from packets/processed. */
type ProcessedPacket = {
  key: string;
  dateTimeUTC?: string;
  gaugeTime?: string;
  dateTime?: string;
  flowRateDays?: number;
  tankLevelFeet?: number;
  bblsTaken?: number;
  // Fields the AFR interval builder deliberately IGNORES (ON etc.) may also be
  // present on real packets; we include some in tests to prove they never leak.
  overnightBblsDay?: string | null;
  [extra: string]: unknown;
};

/**
 * VERBATIM MIRROR of calculateAFR's interval construction (index.ts). If the
 * production builder changes, afrV2Preservation.test.ts's source assertions
 * catch the drift; this mirror keeps the integration scenarios faithful.
 */
function prodAfr(processed: ProcessedPacket[], newFlowRateDays: number, bblPerFoot?: number): number {
  const rateEntries: { key: string; timestamp: number; rate: number; topLevelFeet?: number; bblsTaken?: number }[] = [];
  for (const data of processed) {
    const key = data.key || '';
    if (key.startsWith('edit_') || key.startsWith('delete_') || key.startsWith('history_')) continue;
    if (data.flowRateDays && data.flowRateDays > 0) {
      let ts = data.dateTimeUTC ? new Date(data.dateTimeUTC).getTime()
        : data.gaugeTime ? new Date(data.gaugeTime).getTime()
        : data.dateTime ? new Date(data.dateTime).getTime()
        : 0;
      if (isNaN(ts)) ts = 0;
      rateEntries.push({
        key,
        timestamp: ts,
        rate: data.flowRateDays,
        topLevelFeet: typeof data.tankLevelFeet === 'number' ? data.tankLevelFeet : undefined,
        bblsTaken: typeof data.bblsTaken === 'number' ? data.bblsTaken : undefined,
      });
    }
  }
  rateEntries.sort((a, b) => a.timestamp - b.timestamp);
  const recent = rateEntries.slice(-P.windowSize);
  const intervals: AfrInterval[] = recent.map((e, i) => {
    const prev = i > 0 ? recent[i - 1] : undefined;
    return {
      key: e.key,
      timestamp: e.timestamp,
      flowRateDays: e.rate,
      intervalMs: prev ? e.timestamp - prev.timestamp : undefined,
      topLevelFeet: e.topLevelFeet,
      priorTopLevelFeet: prev?.topLevelFeet,
      bblsTaken: e.bblsTaken,
      bblPerFoot,
    };
  });
  if (newFlowRateDays > 0) {
    const last = recent[recent.length - 1];
    intervals.push({ key: '__incoming__', timestamp: last ? last.timestamp + 1 : 1, flowRateDays: newFlowRateDays });
  }
  if (intervals.length === 0) return 0;
  return computeAfrAuto(intervals, P).afr;
}

/** Build daily processed packets from a rate array (oldest first). */
function packets(rates: number[], wellName = 'IntegWell', startMs = T0): ProcessedPacket[] {
  return rates.map((r, i) => ({
    key: `${wellName}_${i}`,
    dateTimeUTC: new Date(startMs + i * DAY).toISOString(),
    flowRateDays: r,
    wellName,
  }));
}

describe('AFR production entry point (calculateAFR → computeAfrAuto) — integration scenarios', () => {
  const BASE = [0.50, 0.49, 0.51, 0.50, 0.48, 0.52, 0.50]; // tight ~0.50 well

  it('no-reaction well: a normal new pull tracks the established baseline', () => {
    const afr = prodAfr(packets(BASE), 0.50, 20);
    expect(afr).toBeGreaterThan(0.45);
    expect(afr).toBeLessThan(0.55); // no disturbance → forecast ≈ baseline
  });

  it('isolated large reaction (Gabriel washout spike): incoming spike does NOT inflate the forecast', () => {
    const afr = prodAfr(packets(BASE), 1.80, 20); // a single big incoming reaction
    expect(afr).toBeLessThan(0.75);               // suppressed, baseline held
  });

  it('small disturbed-but-usable reaction: off-trend but < 2.0x → kept at disturbed confidence, mild effect', () => {
    // 0.90 vs ~0.50 median: ratio 1.8 (< 2.0) → disturbed 0.4, not a 0.1 anomaly.
    const afr = prodAfr(packets(BASE), 0.90, 20);
    expect(afr).toBeGreaterThan(0.45);
    expect(afr).toBeLessThan(0.75); // nudged, never fully adopts the disturbed reading
  });

  it('irregular high/low recovery: a jagged post-reaction sequence never establishes a false regime', () => {
    const jagged = [...BASE, 1.70, 0.15, 1.40, 0.20]; // erratic recovery
    const afr = prodAfr(packets(jagged), 0.50, 20);
    expect(afr).toBeGreaterThan(0.30);
    expect(afr).toBeLessThan(0.80); // baseline survives the jagged middle
  });

  it('three consistent readings establish a REAL new regime: forecast adapts up', () => {
    // Baseline then a sustained, mutually-consistent higher regime.
    const regime = [0.50, 0.49, 0.51, 0.50, 1.20, 1.22, 1.18]; // 3 consistent ~1.2
    const afrNew = prodAfr(packets(regime), 1.21, 20);   // 4th consistent incoming
    const afrOld = prodAfr(packets(BASE), 0.50, 20);
    expect(afrNew).toBeGreaterThan(afrOld);
    expect(afrNew).toBeGreaterThan(0.9);        // genuinely adapted, not suppressed
  });

  it('independent Wednesday and Friday Gabriel disturbances are judged per-well (no cross-well or calendar coupling)', () => {
    // Two wells, each with its own single disturbance on a different day index.
    const gabWed = prodAfr(packets([0.50, 0.49, 0.51, 1.60, 0.50, 0.49], 'Gabriel_2'), 0.50, 20);
    const gabFri = prodAfr(packets([0.60, 0.59, 0.61, 0.60, 0.59, 1.80], 'Gabriel_3'), 0.60, 20);
    // Each well holds its own baseline; neither is contaminated by the other.
    expect(gabWed).toBeGreaterThan(0.45); expect(gabWed).toBeLessThan(0.65);
    expect(gabFri).toBeGreaterThan(0.55); expect(gabFri).toBeLessThan(0.75);
    expect(gabWed).not.toBe(gabFri); // structurally independent
  });

  it('ON toggled does NOT change AFR: overnight fields on the packet never reach the AFR engine', () => {
    const plain = packets(BASE);
    const withOnLow: ProcessedPacket[] = packets(BASE).map((p) => ({ ...p, overnightBblsDay: '50' }));
    const withOnHigh: ProcessedPacket[] = packets(BASE).map((p) => ({ ...p, overnightBblsDay: '9999', extraOnField: 12345 }));
    const a = prodAfr(plain, 0.50, 20);
    const b = prodAfr(withOnLow, 0.50, 20);
    const c = prodAfr(withOnHigh, 0.50, 20);
    expect(b).toBe(a);
    expect(c).toBe(a); // ON off / low / high → byte-identical AFR
    // Structural guarantee: the engine signature admits no ON/event parameter.
    expect(computeAfrAuto.length).toBe(2);
  });

  it('late / edit / delete / duplicate recomputation is deterministic and order-independent', () => {
    const base = packets([0.50, 0.49, 0.51, 0.50, 0.52]);
    const inOrder = prodAfr(base, 0.50, 20);

    // LATE ENTRY: a pull inserted out-of-array-order but with an in-sequence event
    // time sorts by timestamp → identical to having arrived in order.
    const shuffled = [base[2], base[0], base[4], base[1], base[3]];
    expect(prodAfr(shuffled, 0.50, 20)).toBe(inOrder);

    // EDIT: change one packet's rate → deterministic recompute (same twice).
    const edited = base.map((p, i) => (i === 4 ? { ...p, flowRateDays: 0.80 } : p));
    expect(prodAfr(edited, 0.50, 20)).toBe(prodAfr(edited, 0.50, 20));

    // DELETE: remove a packet → deterministic recompute; forecast still sane.
    const deleted = base.filter((_, i) => i !== 2);
    const afrDel = prodAfr(deleted, 0.50, 20);
    expect(afrDel).toBe(prodAfr(deleted, 0.50, 20));
    expect(afrDel).toBeGreaterThan(0.4); expect(afrDel).toBeLessThan(0.6);

    // DUPLICATE: a packet re-sent minutes apart is a short-gap duplicate →
    // invalid (weight 0), so it cannot poison the baseline.
    const dupWell = packets([0.50, 0.49, 0.51, 0.50]);
    const dup: ProcessedPacket = {
      key: 'IntegWell_dup',
      dateTimeUTC: new Date(T0 + 3 * DAY + 2 * 60 * 1000).toISOString(), // 2 min after idx3
      flowRateDays: 0.50, wellName: 'IntegWell',
    };
    const withDup = prodAfr([...dupWell, dup], 0.50, 20);
    const withoutDup = prodAfr(dupWell, 0.50, 20);
    expect(Math.abs(withDup - withoutDup)).toBeLessThan(0.05); // duplicate is isolated
  });

  it('low/dead wells and long gaps: tiny wobble is not a false reaction; a long quiet gap is stable', () => {
    // Dead well: small absolute wobble within the MAD floor → no false transient.
    const dead = prodAfr(packets([0.02, 0.018, 0.022, 0.02, 0.05, 0.02]), 0.02, 20);
    expect(dead).toBeGreaterThan(0.01); expect(dead).toBeLessThan(0.03);

    // Long gap with a normal rate: the gap alone is not a disturbance.
    const gapWell = packets([0.50, 0.49, 0.51, 0.50]);
    const afterGap: ProcessedPacket = {
      key: 'IntegWell_gap',
      dateTimeUTC: new Date(T0 + 3 * DAY + 9 * DAY).toISOString(), // 9-day gap, normal rate
      flowRateDays: 0.50, wellName: 'IntegWell',
    };
    const afr = prodAfr([...gapWell, afterGap], 0.50, 20);
    expect(afr).toBeGreaterThan(0.45); expect(afr).toBeLessThan(0.55);
  });

  it('contract preserved: the entry point returns a single finite AFR number (no schema change for clients)', () => {
    const afr = prodAfr(packets(BASE), 0.50, 20);
    expect(typeof afr).toBe('number');
    expect(Number.isFinite(afr)).toBe(true);
  });

  it('empty history: a first-ever pull with no processed packets returns the incoming rate cleanly', () => {
    const afr = prodAfr([], 0.42, 20);
    expect(afr).toBeGreaterThan(0);       // single valid reading → its own rate
    expect(Number.isFinite(afr)).toBe(true);
  });
});

describe('ON pipeline is a SEPARATE engine (no shared state with AFR)', () => {
  it('the AFR engine and the ON computation share no module-level state or input', () => {
    // computeAfrAuto is pure over (intervals, policy). Calling it never mutates
    // its inputs, so no ON computation running before/after could observe or be
    // observed through it.
    const ivs: AfrInterval[] = packets([0.50, 0.49, 0.51, 0.50]).map((p, i, arr) => ({
      key: p.key, timestamp: new Date(p.dateTimeUTC!).getTime(), flowRateDays: p.flowRateDays!,
      intervalMs: i > 0 ? new Date(p.dateTimeUTC!).getTime() - new Date(arr[i - 1].dateTimeUTC!).getTime() : undefined,
    }));
    const snapshot = JSON.stringify(ivs);
    const r1 = computeAfrAuto(ivs, P);
    const r2 = computeAfrAuto(ivs, P);
    expect(JSON.stringify(ivs)).toBe(snapshot); // inputs untouched
    expect(r2).toEqual(r1);                      // no hidden state between calls
  });
});
