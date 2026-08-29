// Phase-1 regression freeze — Crossbow 1 watchdog defect (2026-08-28).
//
// Production evidence (read-only audit):
//   original  20260828_092503_Crossbow1_dstw6f   ingestedAt 1787927108195 (14:25:08.195Z)
//   watchdog sweep began                          14:25:08.889Z  (694 ms later)
//   deployed key-parse judged the LOCAL-time key prefix `20260828_092503` as
//   09:25:03Z → apparent age ≈ 5 h → "stranded" → re-keyed clone
//   20260828_142508_Crossbow1_c8neoe → STALE_PULL_TIME rejected wrapper.
//
// The trusted-age contract: age comes from server-stamped ingestedAt only.
import { estimatePacketAge, isStranded, STRANDED_THRESHOLD_MS } from '../watchdogAge';

const CROSSBOW_INGESTED_AT = 1787927108195;           // 2026-08-28T14:25:08.195Z
const WATCHDOG_SWEEP_MS = Date.parse('2026-08-28T14:25:08.889Z');

describe('watchdog age — trusted server timestamp, never the packet key', () => {
  test('Crossbow shape: 694 ms old at the sweep — NOT stranded', () => {
    const age = estimatePacketAge({ ingestedAt: CROSSBOW_INGESTED_AT }, WATCHDOG_SWEEP_MS);
    expect(age).toEqual({ kind: 'known', ageMs: 694 });
    expect(isStranded(age)).toBe(false);
  });

  test('the deployed key-parse defect is exactly what this replaces: local key read as UTC looked ~5 h old', () => {
    // The defect, reproduced: parse the local-time key prefix with a Z suffix.
    const keyParsedAsUtc = Date.parse('2026-08-28T09:25:03Z');
    const apparentAgeMs = WATCHDOG_SWEEP_MS - keyParsedAsUtc;
    expect(apparentAgeMs).toBeGreaterThan(4.9 * 60 * 60 * 1000); // ≈ 5 hours
    expect(apparentAgeMs).toBeGreaterThan(STRANDED_THRESHOLD_MS); // → wrongly "stranded"
    // The trusted estimator ignores the key entirely — same packet, 694 ms.
    expect(isStranded(estimatePacketAge({ ingestedAt: CROSSBOW_INGESTED_AT }, WATCHDOG_SWEEP_MS))).toBe(false);
  });

  test('truly stale packet (3 minutes by ingestedAt) IS stranded', () => {
    const age = estimatePacketAge({ ingestedAt: WATCHDOG_SWEEP_MS - 3 * 60 * 1000 }, WATCHDOG_SWEEP_MS);
    expect(isStranded(age)).toBe(true);
  });

  test('exactly at the threshold is not yet stranded; just past it is', () => {
    const at = estimatePacketAge({ ingestedAt: WATCHDOG_SWEEP_MS - STRANDED_THRESHOLD_MS }, WATCHDOG_SWEEP_MS);
    expect(isStranded(at)).toBe(false);
    const past = estimatePacketAge({ ingestedAt: WATCHDOG_SWEEP_MS - STRANDED_THRESHOLD_MS - 1 }, WATCHDOG_SWEEP_MS);
    expect(isStranded(past)).toBe(true);
  });

  test('missing ingestedAt → unknown age → never stranded from a guess', () => {
    const age = estimatePacketAge({}, WATCHDOG_SWEEP_MS);
    expect(age).toEqual({ kind: 'unknown', reason: 'missing_ingestedAt' });
    expect(isStranded(age)).toBe(false);
    expect(isStranded(estimatePacketAge(null, WATCHDOG_SWEEP_MS))).toBe(false);
  });

  test('malformed ingestedAt (string junk, NaN, implausible epoch) → unknown → not stranded', () => {
    for (const bad of ['yesterday', NaN, Infinity, -5, 0, 12345, 5e15]) {
      const age = estimatePacketAge({ ingestedAt: bad }, WATCHDOG_SWEEP_MS);
      expect(age.kind).toBe('unknown');
      expect(isStranded(age)).toBe(false);
    }
    // A numeric string that IS a plausible epoch is accepted (RTDB round-trips).
    expect(estimatePacketAge({ ingestedAt: String(CROSSBOW_INGESTED_AT) }, WATCHDOG_SWEEP_MS))
      .toEqual({ kind: 'known', ageMs: 694 });
  });

  test('ingestedAt slightly in the future (instance clock skew) clamps to age 0 — not stranded', () => {
    const age = estimatePacketAge({ ingestedAt: WATCHDOG_SWEEP_MS + 2500 }, WATCHDOG_SWEEP_MS);
    expect(age).toEqual({ kind: 'known', ageMs: 0 });
    expect(isStranded(age)).toBe(false);
  });
});
