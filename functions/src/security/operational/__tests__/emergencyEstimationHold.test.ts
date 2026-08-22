/**
 * Emergency estimation hold — decisions, digest, concurrency.
 *
 * The mistake that would matter is a live well left suppressed after a driver
 * pulled it. Most of this file exists to prove that cannot happen, including
 * when the pull lands in the middle of Apply.
 */
import { createHash } from 'node:crypto';
import {
  buildHoldPlan,
  computePreviewDigest,
  decideEstimationHold,
  holdSuppressesEstimation,
  holdTransactionUpdate,
  parseHoldTargets,
  type EstimationHoldRecord,
  type HoldObservation,
} from '../emergencyEstimationHold';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const PULL = '2026-08-20T17:42:02.991Z';
const NEWER = '2026-08-23T06:00:00.000Z';
const UID = 'admin-uid-1';

function observation(over: Partial<HoldObservation> = {}): HoldObservation {
  return {
    outgoing: {
      responseId: 'response_20260820_174213_Gabriel1',
      lastPullDateTimeUTC: PULL,
      lastPullBottomLevel: "2'7\"",
      currentLevel: "2'7\"",
      wellDown: false,
    },
    statusIsDown: false,
    hold: null,
    config: { companyId: 'liquid-gold', avgFlowRate: '6:00:33', avgFlowRateMinutes: 360.56 },
    ...over,
  };
}
const target = { wellName: 'Gabriel 1', expectedLastPullUTC: PULL };

// ── the identity binding ────────────────────────────────────────────────────

describe('holdSuppressesEstimation', () => {
  it('suppresses while the hold matches the current pull', () => {
    expect(holdSuppressesEstimation({ active: true, heldAtPullUTC: PULL }, PULL)).toBe(true);
  });

  it('STOPS suppressing the moment a newer pull lands — no write required', () => {
    // This is the whole safety property: a concurrent pull cannot be hidden.
    expect(holdSuppressesEstimation({ active: true, heldAtPullUTC: PULL }, NEWER)).toBe(false);
  });

  it('ignores an inactive, malformed, or unbound hold', () => {
    expect(holdSuppressesEstimation({ active: false, heldAtPullUTC: PULL }, PULL)).toBe(false);
    expect(holdSuppressesEstimation({ active: true }, PULL)).toBe(false);
    expect(holdSuppressesEstimation(null, PULL)).toBe(false);
    expect(holdSuppressesEstimation({ active: true, heldAtPullUTC: PULL }, null)).toBe(false);
  });
});

// ── decisions ───────────────────────────────────────────────────────────────

describe('decideEstimationHold', () => {
  it('holds a well whose stated evidence still holds, writing one path', () => {
    const d = decideEstimationHold(target, observation());
    expect(d.action).toBe('apply_hold');
    expect(d.willWrite).toEqual(['wells/Gabriel 1/estimationHold']);
  });

  it('never writes pull data, flow rate, isDown or an outgoing row', () => {
    const d = decideEstimationHold(target, observation());
    for (const p of d.willWrite) {
      expect(p).not.toMatch(/lastPull|avgFlowRate|isDown|wellDown|packets\/|editHistory|currentLevel/i);
      expect(p).toMatch(/^wells\/[^/]+\/estimationHold$/);
    }
  });

  it('REFUSES when a newer pull arrived after the preview', () => {
    const d = decideEstimationHold(target, observation({
      outgoing: { ...observation().outgoing!, lastPullDateTimeUTC: NEWER },
    }));
    expect(d.action).toBe('refuse_evidence_mismatch');
    expect(d.willWrite).toEqual([]);
  });

  it('leaves a physically down well alone — the two states stay separate', () => {
    for (const over of [
      { statusIsDown: true },
      { outgoing: { ...observation().outgoing!, wellDown: true } },
    ]) {
      const d = decideEstimationHold(target, observation(over as Partial<HoldObservation>));
      expect(d.action).toBe('skip_physically_down');
      expect(d.willWrite).toEqual([]);
      expect(d.observed.wellDown).toBe(true);
    }
  });

  it('skips a well already held for this exact pull', () => {
    const d = decideEstimationHold(target, observation({
      hold: { active: true, heldAtPullUTC: PULL },
    }));
    expect(d.action).toBe('skip_already_held');
  });

  it('treats a hold bound to an older pull as absent, and re-holds', () => {
    const d = decideEstimationHold(target, observation({
      hold: { active: true, heldAtPullUTC: '2026-08-01T00:00:00.000Z' },
    }));
    expect(d.observed.holdActive).toBe(false);
    expect(d.action).toBe('apply_hold');
  });

  it('refuses a well with no status row', () => {
    expect(decideEstimationHold(target, observation({ outgoing: null })).action)
      .toBe('refuse_missing_status');
  });

  it('echoes flow rate and pull boundary for the reviewer, unmodified', () => {
    const d = decideEstimationHold(target, observation());
    expect(d.observed.avgFlowRate).toBe('6:00:33');
    expect(d.observed.avgFlowRateMinutes).toBe(360.56);
    expect(d.observed.lastPullDateTimeUTC).toBe(PULL);
    expect(d.observed.lastPullBottomLevel).toBe("2'7\"");
  });
});

// ── identity-bound digest ───────────────────────────────────────────────────

describe('preview digest', () => {
  const decisionsFor = (o: HoldObservation) => [decideEstimationHold(target, o)];

  it('is stable for identical state and caller', () => {
    expect(computePreviewDigest(UID, decisionsFor(observation()), sha256))
      .toBe(computePreviewDigest(UID, decisionsFor(observation()), sha256));
  });

  it('changes when a new pull lands', () => {
    const a = computePreviewDigest(UID, decisionsFor(observation()), sha256);
    const b = computePreviewDigest(UID, decisionsFor(observation({
      outgoing: { ...observation().outgoing!, lastPullDateTimeUTC: NEWER },
    })), sha256);
    expect(a).not.toBe(b);
  });

  it('changes when the response id changes', () => {
    const a = computePreviewDigest(UID, decisionsFor(observation()), sha256);
    const b = computePreviewDigest(UID, decisionsFor(observation({
      outgoing: { ...observation().outgoing!, responseId: 'response_other' },
    })), sha256);
    expect(a).not.toBe(b);
  });

  it('changes when the well becomes physically down', () => {
    const a = computePreviewDigest(UID, decisionsFor(observation()), sha256);
    const b = computePreviewDigest(UID, decisionsFor(observation({ statusIsDown: true })), sha256);
    expect(a).not.toBe(b);
  });

  it('is bound to the caller — one reviewer approval is not another', () => {
    expect(computePreviewDigest(UID, decisionsFor(observation()), sha256))
      .not.toBe(computePreviewDigest('other-admin', decisionsFor(observation()), sha256));
  });

  it('is order-independent across wells', () => {
    const d1 = decideEstimationHold({ wellName: 'A', expectedLastPullUTC: PULL }, observation());
    const d2 = decideEstimationHold({ wellName: 'B', expectedLastPullUTC: PULL }, observation());
    expect(computePreviewDigest(UID, [d1, d2], sha256))
      .toBe(computePreviewDigest(UID, [d2, d1], sha256));
  });
});

// ── concurrency ─────────────────────────────────────────────────────────────

describe('hold transaction', () => {
  const rec = (pull: string): EstimationHoldRecord => ({ active: true, heldAtPullUTC: pull });

  it('writes when no hold exists', () => {
    expect(holdTransactionUpdate(null, rec(PULL))).toEqual(rec(PULL));
  });

  it('ABORTS when another writer already held this exact pull', () => {
    expect(holdTransactionUpdate({ active: true, heldAtPullUTC: PULL }, rec(PULL))).toBeUndefined();
  });

  it('replaces a hold bound to a different pull', () => {
    expect(holdTransactionUpdate({ active: true, heldAtPullUTC: '2026-08-01T00:00:00.000Z' }, rec(PULL)))
      .toEqual(rec(PULL));
  });

  it('a pull landing between Preview, Apply-read and Apply-write cannot hide the well', () => {
    // Preview saw PULL.
    const previewed = decideEstimationHold(target, observation());
    const digestAtPreview = computePreviewDigest(UID, [previewed], sha256);

    // A real pull lands. Apply re-reads and now sees NEWER.
    const atApply = observation({
      outgoing: { ...observation().outgoing!, lastPullDateTimeUTC: NEWER, responseId: 'response_new' },
    });
    const reDecided = decideEstimationHold(target, atApply);
    const digestAtApply = computePreviewDigest(UID, [reDecided], sha256);

    // Gate 1: the digest no longer matches, so the batch is refused outright.
    expect(digestAtApply).not.toBe(digestAtPreview);
    // Gate 2: even if it were applied, the decision itself refuses.
    expect(reDecided.action).toBe('refuse_evidence_mismatch');
    // Gate 3: and even a hold written against the OLD pull is inert, because
    // the binding no longer matches the well's current pull.
    expect(holdSuppressesEstimation({ active: true, heldAtPullUTC: PULL }, NEWER)).toBe(false);
  });
});

// ── plan + input validation ─────────────────────────────────────────────────

describe('plan and input', () => {
  it('counts outcomes and reports only real writes', () => {
    const plan = buildHoldPlan([
      decideEstimationHold(target, observation()),
      decideEstimationHold(target, observation({ statusIsDown: true })),
      decideEstimationHold(target, observation({ outgoing: null })),
    ], true, UID, sha256);
    expect(plan.counts.apply_hold).toBe(1);
    expect(plan.counts.skip_physically_down).toBe(1);
    expect(plan.counts.refuse_missing_status).toBe(1);
    expect(plan.willWriteCount).toBe(1);
    expect(plan.previewDigest).toHaveLength(64);
  });

  it('rejects path-escaping names and malformed batches', () => {
    for (const bad of ['a/b', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b']) {
      expect(() => parseHoldTargets([{ wellName: bad, expectedLastPullUTC: PULL }])).toThrow('invalid_wellName');
    }
    expect(() => parseHoldTargets([])).toThrow('targets_required');
    expect(() => parseHoldTargets([
      { wellName: 'A', expectedLastPullUTC: PULL }, { wellName: 'A', expectedLastPullUTC: PULL },
    ])).toThrow('duplicate_well');
    expect(() => parseHoldTargets([{ wellName: 'A', expectedLastPullUTC: 'soon' }]))
      .toThrow('invalid_expectedLastPullUTC');
  });
});
