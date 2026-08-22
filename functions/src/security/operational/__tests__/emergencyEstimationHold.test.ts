/**
 * Emergency estimation hold — full-pool selection, CAS, and safety.
 *
 * The mistake that would matter is a live well left suppressed, or a well
 * proposed on evidence that is not its own. Most of this file exists to prove
 * neither happens.
 */
import { createHash } from 'node:crypto';
import {
  buildHoldPlan,
  computePreviewDigest,
  computePullIntervalStats,
  decideEstimationHold,
  holdCompareAndSet,
  holdCompensate,
  holdFingerprint,
  holdSuppressesEstimation,
  parseBottomInches,
  MIN_PULLS_FOR_AVERAGE,
  type EstimationHoldRecord,
  type HoldObservation,
} from '../emergencyEstimationHold';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const H = 3_600_000;
const PULL = '2026-08-20T17:42:02.991Z';
const PULL_MS = Date.parse(PULL);
const NEWER = '2026-08-23T06:00:00.000Z';
const UID = 'admin-uid-1';

/** Pulls every 24h ending at PULL — a 24h average. */
const cadence24h = (n = 5) =>
  Array.from({ length: n }, (_, i) => PULL_MS - (n - 1 - i) * 24 * H);

function observation(over: Partial<HoldObservation> = {}): HoldObservation {
  return {
    outgoing: {
      responseId: 'response_20260820_174213_Gabriel1',
      lastPullDateTimeUTC: PULL,
      lastPullBottomLevel: "2'7\"",
      currentLevel: "9'9\"",
      wellDown: false,
    },
    statusIsDown: false,
    hold: null,
    acceptedPullMs: cadence24h(),
    config: { companyId: 'liquid-gold', avgFlowRate: '6:00:33', avgFlowRateMinutes: 360.56 },
    ...over,
  };
}
const decide = (asOfMs: number, over: Partial<HoldObservation> = {}) =>
  decideEstimationHold({ wellName: 'Gabriel 1', asOfMs, observed: observation(over) });

// ── 1. historical-average selection ─────────────────────────────────────────

describe('computePullIntervalStats', () => {
  it('averages the real gaps between consecutive pulls', () => {
    const B = Date.parse('2026-08-01T00:00:00Z');
    const s = computePullIntervalStats([B, B + 10 * H, B + 30 * H]); // gaps 10h, 20h
    expect(s.pullCount).toBe(3);
    expect(s.intervalCount).toBe(2);
    expect(s.averageIntervalMs).toBe(15 * H);
    expect(s.latestPullMs).toBe(B + 30 * H);
  });

  it('sorts unordered input before differencing', () => {
    const B = Date.parse('2026-08-01T00:00:00Z');
    expect(computePullIntervalStats([B + 30 * H, B, B + 10 * H]).averageIntervalMs).toBe(15 * H);
  });

  it('drops duplicates so a repeat cannot deflate the average', () => {
    const B = Date.parse('2026-08-01T00:00:00Z');
    const s = computePullIntervalStats([B, B + 10 * H, B + 10 * H, B + 20 * H]);
    expect(s.pullCount).toBe(3);
    expect(s.averageIntervalMs).toBe(10 * H);
  });

  it('ignores non-finite and non-positive timestamps', () => {
    const B = Date.parse('2026-08-01T00:00:00Z');
    const s = computePullIntervalStats([NaN, -1, 0, B + 10 * H, B + 20 * H]);
    expect(s.pullCount).toBe(2);
    expect(s.averageIntervalMs).toBe(10 * H);
  });

  it('reports no average from a single pull', () => {
    const s = computePullIntervalStats([Date.parse('2026-08-01T00:00:00Z')]);
    expect(s.intervalCount).toBe(0);
    expect(s.averageIntervalMs).toBeNull();
  });
});

describe('full-pool selection by the well\'s own cadence', () => {
  it('proposes when elapsed exceeds this well\'s average interval', () => {
    const d = decide(PULL_MS + 30 * H); // 24h average, 30h elapsed
    expect(d.action).toBe('apply_hold');
    expect(d.history.averageIntervalHours).toBe(24);
    expect(d.history.elapsedHours).toBe(30);
    expect(d.history.overdueRatio).toBeCloseTo(1.25, 3);
    expect(d.willWrite).toEqual(['wells/Gabriel 1/estimationHold']);
  });

  it('does not propose while still within the average', () => {
    const d = decide(PULL_MS + 20 * H);
    expect(d.action).toBe('skip_within_average');
    expect(d.willWrite).toEqual([]);
  });

  it('treats exactly-at-average as not yet overdue', () => {
    expect(decide(PULL_MS + 24 * H).action).toBe('skip_within_average');
  });

  it('proposes a slow well on its OWN long cadence, not a global rule', () => {
    // Pulled every 21 days. At 30 days elapsed it is overdue for itself, even
    // though a 24h-cadence well would have been overdue weeks earlier.
    const monthly = Array.from({ length: 4 }, (_, i) => PULL_MS - (3 - i) * 21 * 24 * H);
    expect(decide(PULL_MS + 20 * 24 * H, { acceptedPullMs: monthly }).action).toBe('skip_within_average');
    expect(decide(PULL_MS + 30 * 24 * H, { acceptedPullMs: monthly }).action).toBe('apply_hold');
  });

  it('needs no avgFlowRateMinutes at all', () => {
    const d = decide(PULL_MS + 30 * H, { config: { companyId: 'liquid-gold' } });
    expect(d.action).toBe('apply_hold');
    expect(d.observed.avgFlowRateMinutes).toBeNull();
  });

  it('does not blanket-exclude a long-dormant well — it is judged on its cadence', () => {
    const d = decide(PULL_MS + 400 * 24 * H);
    expect(d.action).toBe('apply_hold');
    expect(d.history.overdueRatio).toBeGreaterThan(100);
  });
});

// ── 2. insufficient history ─────────────────────────────────────────────────

describe('insufficient history', () => {
  it('reports, rather than proposes, when there are too few pulls', () => {
    for (const pulls of [[], [PULL_MS], [PULL_MS - 24 * H, PULL_MS]]) {
      const d = decide(PULL_MS + 999 * H, { acceptedPullMs: pulls });
      expect(d.action).toBe('insufficient_history');
      expect(d.willWrite).toEqual([]);
      expect(d.history.pullCount).toBe(pulls.length);
    }
  });

  it(`accepts exactly ${MIN_PULLS_FOR_AVERAGE} pulls as enough`, () => {
    const d = decide(PULL_MS + 30 * H, { acceptedPullMs: cadence24h(MIN_PULLS_FOR_AVERAGE) });
    expect(d.action).toBe('apply_hold');
  });

  it('exposes the evidence count even when it refuses', () => {
    const d = decide(PULL_MS + 999 * H, { acceptedPullMs: [PULL_MS] });
    expect(d.history.pullCount).toBe(1);
    expect(d.history.intervalCount).toBe(0);
    expect(d.history.averageIntervalMs).toBeNull();
  });
});

// ── 3. physical down ────────────────────────────────────────────────────────

describe('physically down wells', () => {
  it('is evaluated and reported, but never held', () => {
    for (const over of [
      { statusIsDown: true },
      { outgoing: { ...observation().outgoing!, wellDown: true } },
    ]) {
      const d = decide(PULL_MS + 999 * H, over as Partial<HoldObservation>);
      expect(d.action).toBe('skip_physically_down');
      expect(d.willWrite).toEqual([]);
      expect(d.observed.wellDown).toBe(true);
      // Reported, not dropped: the arithmetic is still there to read.
      expect(d.history.pullCount).toBeGreaterThan(0);
      expect(d.history.averageIntervalMs).not.toBeNull();
    }
  });
});

// ── 4. valid freeze point ───────────────────────────────────────────────────

describe('bottom level', () => {
  it('parses feet/inches, and 0 means unusable', () => {
    expect(parseBottomInches("2'7\"")).toBe(31);
    expect(parseBottomInches('')).toBe(0);
    expect(parseBottomInches(undefined)).toBe(0);
    expect(parseBottomInches('n/a')).toBe(0);
    expect(parseBottomInches(31 as unknown)).toBe(0);
  });

  it('REFUSES a hold when the bottom level is missing or unparsable', () => {
    for (const bad of [undefined, '', 'n/a', 'DOWN']) {
      const d = decide(PULL_MS + 30 * H, {
        outgoing: { ...observation().outgoing!, lastPullBottomLevel: bad as string },
      });
      expect(d.action).toBe('refuse_missing_bottom');
      expect(d.willWrite).toEqual([]);
    }
  });

  it('never falls back to the running estimate as a freeze point', () => {
    const d = decide(PULL_MS + 30 * H, {
      outgoing: { ...observation().outgoing!, lastPullBottomLevel: undefined, currentLevel: "9'9\"" },
    });
    expect(d.action).toBe('refuse_missing_bottom');
    expect(d.observed.lastPullBottomInches).toBeNull();
  });

  it('carries the exact bottom into the decision', () => {
    expect(decide(PULL_MS + 30 * H).observed.lastPullBottomInches).toBe(31);
  });
});

// ── 5. digest ───────────────────────────────────────────────────────────────

describe('preview digest', () => {
  const dig = (asOf: number, over: Partial<HoldObservation> = {}) =>
    computePreviewDigest(UID, asOf, [decide(asOf, over)], sha256);

  it('is stable for identical state, caller and asOf', () => {
    expect(dig(PULL_MS + 30 * H)).toBe(dig(PULL_MS + 30 * H));
  });

  it('changes with asOf', () => {
    expect(dig(PULL_MS + 30 * H)).not.toBe(dig(PULL_MS + 31 * H));
  });

  it('changes when a newer pull lands', () => {
    expect(dig(PULL_MS + 30 * H)).not.toBe(dig(PULL_MS + 30 * H, {
      outgoing: { ...observation().outgoing!, lastPullDateTimeUTC: NEWER },
    }));
  });

  it('changes when history evidence changes', () => {
    expect(dig(PULL_MS + 30 * H)).not.toBe(dig(PULL_MS + 30 * H, { acceptedPullMs: cadence24h(6) }));
  });

  it('changes when the bottom level changes', () => {
    expect(dig(PULL_MS + 30 * H)).not.toBe(dig(PULL_MS + 30 * H, {
      outgoing: { ...observation().outgoing!, lastPullBottomLevel: "3'0\"" },
    }));
  });

  it('changes when an existing hold appears', () => {
    expect(dig(PULL_MS + 30 * H)).not.toBe(dig(PULL_MS + 30 * H, {
      hold: { active: true, heldAtPullUTC: '2026-01-01T00:00:00.000Z' },
    }));
  });

  it('changes when the well becomes physically down', () => {
    expect(dig(PULL_MS + 30 * H)).not.toBe(dig(PULL_MS + 30 * H, { statusIsDown: true }));
  });

  it('is bound to the caller', () => {
    const asOf = PULL_MS + 30 * H;
    expect(computePreviewDigest(UID, asOf, [decide(asOf)], sha256))
      .not.toBe(computePreviewDigest('other', asOf, [decide(asOf)], sha256));
  });
});

// ── 6. compare-and-set ──────────────────────────────────────────────────────

describe('holdCompareAndSet', () => {
  const next: EstimationHoldRecord = { active: true, heldAtPullUTC: PULL, applyOpId: 'op-new' };

  it('writes when the live state is exactly what Preview saw', () => {
    expect(holdCompareAndSet(null, holdFingerprint(null), next)).toEqual(next);
  });

  it('ABORTS when a different hold appeared since Preview', () => {
    const observedNone = holdFingerprint(null);
    const live = { active: true, heldAtPullUTC: PULL, applyOpId: 'op-other', heldAtMs: 5 };
    expect(holdCompareAndSet(live, observedNone, next)).toBeUndefined();
  });

  it('ABORTS rather than overwrite a NEWER hold for a different pull', () => {
    // The exact defect Codex found: an older Apply must not erase a newer hold.
    const observedOld = holdFingerprint({ active: true, heldAtPullUTC: PULL, heldAtMs: 1 });
    const live = { active: true, heldAtPullUTC: NEWER, heldAtMs: 2, applyOpId: 'op-newer' };
    expect(holdCompareAndSet(live, observedOld, next)).toBeUndefined();
  });

  it('ABORTS on any drift, even a re-taken hold for the same pull', () => {
    const observed = holdFingerprint({ active: true, heldAtPullUTC: PULL, heldAtMs: 1 });
    const live = { active: true, heldAtPullUTC: PULL, heldAtMs: 999 };
    expect(holdCompareAndSet(live, observed, next)).toBeUndefined();
  });

  it('replaces a hold that is still byte-identical to what Preview saw', () => {
    const live = { active: true, heldAtPullUTC: PULL, heldAtMs: 7, applyOpId: 'op-a' };
    expect(holdCompareAndSet(live, holdFingerprint(live), next)).toEqual(next);
  });
});

describe('holdCompensate — ownership', () => {
  it('removes only a hold this operation wrote', () => {
    expect(holdCompensate({ active: true, heldAtPullUTC: PULL, applyOpId: 'op-1' }, 'op-1')).toBeNull();
  });
  it('refuses to remove another operation\'s hold', () => {
    expect(holdCompensate({ active: true, heldAtPullUTC: PULL, applyOpId: 'op-2' }, 'op-1')).toBeUndefined();
  });
  it('refuses when there is nothing there', () => {
    expect(holdCompensate(null, 'op-1')).toBeUndefined();
  });
});

// ── 7. concurrency: a pull between Preview, Apply-read and Apply-write ──────

describe('concurrent pull during apply', () => {
  it('cannot hide a well — blocked at digest, decision, and binding', () => {
    const asOf = PULL_MS + 30 * H;
    const previewDigest = computePreviewDigest(UID, asOf, [decide(asOf)], sha256);

    // A real pull lands. Apply re-reads and recomputes at the same asOf.
    const after = {
      outgoing: {
        responseId: 'response_new', lastPullDateTimeUTC: NEWER,
        lastPullBottomLevel: "2'0\"", currentLevel: "2'0\"", wellDown: false,
      },
      acceptedPullMs: [...cadence24h(), Date.parse(NEWER)],
    } as Partial<HoldObservation>;
    const reDecided = decide(asOf, after);

    // Gate 1 — digest no longer reproduces, so the whole batch is refused.
    expect(computePreviewDigest(UID, asOf, [reDecided], sha256)).not.toBe(previewDigest);
    // Gate 2 — the recomputed decision is no longer overdue against the new pull.
    expect(reDecided.action).toBe('skip_within_average');
    // Gate 3 — even a hold written against the OLD pull is inert.
    expect(holdSuppressesEstimation({ active: true, heldAtPullUTC: PULL }, NEWER)).toBe(false);
  });

  it('a hold taken then superseded by a pull stops suppressing with no write', () => {
    expect(holdSuppressesEstimation({ active: true, heldAtPullUTC: PULL }, PULL)).toBe(true);
    expect(holdSuppressesEstimation({ active: true, heldAtPullUTC: PULL }, NEWER)).toBe(false);
  });
});

// ── 8. plan ─────────────────────────────────────────────────────────────────

describe('plan', () => {
  it('counts every outcome across the pool and proposes only real writes', () => {
    const asOf = PULL_MS + 30 * H;
    const decisions = [
      decide(asOf),
      decide(asOf, { statusIsDown: true }),
      decide(asOf, { acceptedPullMs: [PULL_MS] }),
      decide(asOf + -10 * H),
      decide(asOf, { outgoing: null }),
      decide(asOf, { outgoing: { ...observation().outgoing!, lastPullBottomLevel: 'n/a' } }),
    ];
    const plan = buildHoldPlan({ decisions, dryRun: true, callerUid: UID, asOfMs: asOf, digest: sha256 });
    expect(plan.counts.apply_hold).toBe(1);
    expect(plan.counts.skip_physically_down).toBe(1);
    expect(plan.counts.insufficient_history).toBe(1);
    expect(plan.counts.skip_within_average).toBe(1);
    expect(plan.counts.refuse_missing_status).toBe(1);
    expect(plan.counts.refuse_missing_bottom).toBe(1);
    expect(plan.willWriteCount).toBe(1);
    expect(plan.asOfMs).toBe(asOf);
    expect(plan.previewDigest).toHaveLength(64);
  });
});
