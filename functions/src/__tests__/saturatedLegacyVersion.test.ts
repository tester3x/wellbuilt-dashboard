// Phase-1 regression freeze — the saturated legacy revision counter.
//
// Production evidence (read-only audit, 2026-08-28): `packets/incoming_version`
// holds the double 4.3005353146607763E20. The Gabriel 5 edit at 09:49:21Z
// logged "Incremented incoming_version to 430053531466077630000" — the SAME
// value it started with. At that magnitude the float64 ULP is 65,536, so the
// legacy `current + 1` transaction is a permanent no-op and every consumer
// waiting for the value to change is starved.
//
// These pins freeze the numeric facts and the consumer semantics that any
// Phase-2 replacement must satisfy. nextIncomingVersion's defect is pinned
// here verbatim; when Phase 2 lands a representable bump, THIS test is updated
// deliberately in the same commit.
import { nextIncomingVersion } from '../incomingVersionPublish';

/** Exact production magnitude read from packets/incoming_version. */
export const SATURATED_LEGACY_VERSION = 4.3005353146607763e20;

/** Old-client comparison (WB-M decideIncomingVersionEvent): strict greater-than
 *  against a persisted appliedVersion. Reproduced here as the semantic pin. */
function oldClientWouldSync(incoming: number, applied: number): boolean {
  return Number.isFinite(incoming) && incoming > applied;
}

describe('saturated legacy incoming_version — frozen production facts', () => {
  test('float64: +1 at the production magnitude is a no-op (ULP is 65,536)', () => {
    const v = SATURATED_LEGACY_VERSION;
    expect(v + 1).toBe(v);                                     // the Gabriel 5 edit log, numerically
    expect(v + 32767).toBe(v);                                 // below half a ULP rounds away entirely
    expect(v + 65536).toBeGreaterThan(v);                      // one ULP IS representable
    expect(Math.pow(2, Math.floor(Math.log2(v)) - 52)).toBe(65536); // spacing proof
    expect(Number.MAX_SAFE_INTEGER).toBe(9007199254740991);    // 2^53−1 integer-precision boundary
    expect(v).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  test('DEPLOYED DEFECT → PHASE-2 BRIDGE: the bump is now representable at the production magnitude', () => {
    // Phase 1 froze the deployed no-op (`+1` bit-identical to the input — the
    // observable "increment" the Dashboard edit logged). Phase 2 deliberately
    // flips this pin: the shared transaction updater now steps by one ULP when
    // +1 is not representable, so the legacy node moves again.
    const bumped = nextIncomingVersion(SATURATED_LEGACY_VERSION);
    expect(bumped).toBeGreaterThan(SATURATED_LEGACY_VERSION);          // observable
    expect(bumped).toBe(SATURATED_LEGACY_VERSION + 65536);             // exactly one ULP
    expect(oldClientWouldSync(bumped, SATURATED_LEGACY_VERSION)).toBe(true); // old strict-greater clients wake
    // Ordinary magnitudes keep the historic +1 exactly.
    expect(nextIncomingVersion(61)).toBe(62);
    expect(nextIncomingVersion('61')).toBe(62);
    expect(nextIncomingVersion(undefined)).toBe(1);
    expect(nextIncomingVersion(Number.MAX_SAFE_INTEGER)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    // Monotone: repeated bumps keep climbing (never a decrease, never a stall).
    let v = SATURATED_LEGACY_VERSION;
    for (let i = 0; i < 5; i++) {
      const next = nextIncomingVersion(v);
      expect(next).toBeGreaterThan(v);
      v = next;
    }
  });

  test('strict-greater consumers are blind exactly while the value cannot move', () => {
    const applied = SATURATED_LEGACY_VERSION;                  // a device that ever applied the node
    expect(oldClientWouldSync(SATURATED_LEGACY_VERSION, applied)).toBe(false); // unchanged → never syncs
    expect(oldClientWouldSync(applied + 1, applied)).toBe(false);              // the deployed +1 no-op, numerically
  });

  test('a downward reset to epoch milliseconds leaves old strict-greater clients permanently blind', () => {
    const applied = SATURATED_LEGACY_VERSION;
    const epochMsNow = 1787927108195;                          // ~1.79e12 — 8 orders of magnitude below
    expect(oldClientWouldSync(epochMsNow, applied)).toBe(false);
    // ...and every later timestamp too: the gap cannot be closed by time.
    expect(oldClientWouldSync(epochMsNow + 10 * 365 * 24 * 3600 * 1000, applied)).toBe(false);
    // Inequality-based consumers (the VBA poller) WOULD see a reset — the
    // asymmetry is why Phase 2 needs a dual contract, not a reset.
    expect(epochMsNow).not.toBe(applied);
  });

  test('what any Phase-2 legacy bridge must satisfy at this magnitude', () => {
    // A compliant bump produces a REPRESENTABLE, MONOTONIC increase from the
    // saturated value (one ULP or more), so both inequality consumers (VBA)
    // and strict-greater consumers (old WB-M) observe it.
    const v = SATURATED_LEGACY_VERSION;
    const ulp = Math.pow(2, Math.floor(Math.log2(v)) - 52);
    const bumped = v + ulp;
    expect(bumped).toBeGreaterThan(v);
    expect(oldClientWouldSync(bumped, v)).toBe(true);
    expect(bumped !== v).toBe(true);
  });
});
