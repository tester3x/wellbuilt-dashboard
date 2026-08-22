/**
 * Emergency well mark-down decisions.
 *
 * The dangerous mistake this operation could make is marking a live well down
 * on stale evidence, hiding it from a driver. Most of what follows is about
 * refusing to do that.
 */
import {
  buildEmergencyWellDownPlan,
  decideEmergencyWellDown,
  parseEmergencyWellDownTargets,
  type EmergencyWellDownObservation,
} from '../emergencyWellDown';

const PULL = '2026-08-20T17:42:02.991Z';

function observation(over: Partial<EmergencyWellDownObservation> = {}): EmergencyWellDownObservation {
  return {
    outgoing: {
      responseId: 'response_20260820_174213_Gabriel1',
      wellName: 'Gabriel 1',
      wellDown: false,
      lastPullDateTimeUTC: PULL,
      lastPullBottomLevel: "2'7\"",
      currentLevel: "2'7\"",
    },
    statusIsDown: false,
    config: { companyId: 'liquid-gold', avgFlowRate: '6:00:33', avgFlowRateMinutes: 360.56 },
    ...over,
  };
}

const target = { wellName: 'Gabriel 1', expectedLastPullUTC: PULL };

describe('decideEmergencyWellDown', () => {
  it('marks down a well whose stated evidence still holds', () => {
    const d = decideEmergencyWellDown(target, observation());
    expect(d.action).toBe('mark_down');
    expect(d.willWrite).toEqual([
      'wells/Gabriel 1/status/isDown',
      'packets/outgoing/response_20260820_174213_Gabriel1/wellDown',
    ]);
  });

  it('writes only the two down flags — never pull data or flow rate', () => {
    const d = decideEmergencyWellDown(target, observation());
    const forbidden = /lastPull|avgFlowRate|currentLevel|bbls|tankTop|packets\/incoming|editHistory/i;
    for (const path of d.willWrite) {
      expect(path).not.toMatch(forbidden);
      expect(path).toMatch(/\/(isDown|wellDown)$/);
    }
    expect(d.willWrite).toHaveLength(2);
  });

  it('echoes the evidence a reviewer needs, unmodified', () => {
    const d = decideEmergencyWellDown(target, observation());
    expect(d.observed).toEqual({
      companyId: 'liquid-gold',
      wellDown: false,
      lastPullDateTimeUTC: PULL,
      lastPullBottomLevel: "2'7\"",
      currentLevel: "2'7\"",
      avgFlowRate: '6:00:33',
      avgFlowRateMinutes: 360.56,
    });
  });

  it('REFUSES when a newer pull arrived after the preview', () => {
    const d = decideEmergencyWellDown(target, observation({
      outgoing: { ...observation().outgoing!, lastPullDateTimeUTC: '2026-08-22T09:00:00.000Z' },
    }));
    expect(d.action).toBe('refuse_evidence_mismatch');
    expect(d.willWrite).toEqual([]);
    expect(d.reason).toContain('2026-08-22T09:00:00.000Z');
  });

  it('REFUSES an older timestamp too — any mismatch, not just newer', () => {
    const d = decideEmergencyWellDown(target, observation({
      outgoing: { ...observation().outgoing!, lastPullDateTimeUTC: '2026-08-01T00:00:00.000Z' },
    }));
    expect(d.action).toBe('refuse_evidence_mismatch');
  });

  it('REFUSES when the well has no status row', () => {
    const d = decideEmergencyWellDown(target, observation({ outgoing: null }));
    expect(d.action).toBe('refuse_missing_status');
    expect(d.willWrite).toEqual([]);
  });

  it('REFUSES when the row carries no pull timestamp at all', () => {
    const d = decideEmergencyWellDown(target, observation({
      outgoing: { ...observation().outgoing!, lastPullDateTimeUTC: undefined },
    }));
    expect(d.action).toBe('refuse_evidence_mismatch');
  });

  it('skips a well already down, by either flag or by stored status', () => {
    for (const over of [
      { outgoing: { ...observation().outgoing!, wellDown: true } },
      { outgoing: { ...observation().outgoing!, isDown: true } },
      { statusIsDown: true },
    ]) {
      const d = decideEmergencyWellDown(target, observation(over as Partial<EmergencyWellDownObservation>));
      expect(d.action).toBe('skip_already_down');
      expect(d.willWrite).toEqual([]);
    }
  });

  it('reports already-down as a skip even when the evidence also mismatches', () => {
    // Order matters: a well someone else marked down is not an alarm.
    const d = decideEmergencyWellDown(target, observation({
      statusIsDown: true,
      outgoing: { ...observation().outgoing!, lastPullDateTimeUTC: '2026-08-22T09:00:00.000Z' },
    }));
    expect(d.action).toBe('skip_already_down');
  });
});

describe('buildEmergencyWellDownPlan', () => {
  it('counts each outcome and reports only real writes', () => {
    const decisions = [
      decideEmergencyWellDown(target, observation()),
      decideEmergencyWellDown(target, observation({ statusIsDown: true })),
      decideEmergencyWellDown(target, observation({ outgoing: null })),
    ];
    const plan = buildEmergencyWellDownPlan(decisions, true);
    expect(plan.dryRun).toBe(true);
    expect(plan.counts).toEqual({
      mark_down: 1, skip_already_down: 1, refuse_missing_status: 1, refuse_evidence_mismatch: 0,
    });
    expect(plan.willWriteCount).toBe(1);
  });
});

describe('parseEmergencyWellDownTargets', () => {
  it('accepts a well-formed list', () => {
    expect(parseEmergencyWellDownTargets([{ wellName: 'Gabriel 1', expectedLastPullUTC: PULL }]))
      .toEqual([{ wellName: 'Gabriel 1', expectedLastPullUTC: PULL }]);
  });

  it('rejects RTDB path-escaping well names', () => {
    for (const bad of ['a/b', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b']) {
      expect(() => parseEmergencyWellDownTargets([{ wellName: bad, expectedLastPullUTC: PULL }]))
        .toThrow('invalid_wellName');
    }
  });

  it('rejects empty, oversized, duplicate and malformed input', () => {
    expect(() => parseEmergencyWellDownTargets([])).toThrow('targets_required');
    expect(() => parseEmergencyWellDownTargets('nope')).toThrow('targets_required');
    expect(() => parseEmergencyWellDownTargets(
      Array.from({ length: 201 }, (_, i) => ({ wellName: `W${i}`, expectedLastPullUTC: PULL })),
    )).toThrow('too_many_targets');
    expect(() => parseEmergencyWellDownTargets([
      { wellName: 'Gabriel 1', expectedLastPullUTC: PULL },
      { wellName: 'Gabriel 1', expectedLastPullUTC: PULL },
    ])).toThrow('duplicate_well');
    expect(() => parseEmergencyWellDownTargets([{ wellName: 'Gabriel 1' }]))
      .toThrow('invalid_expectedLastPullUTC');
    expect(() => parseEmergencyWellDownTargets([{ wellName: 'Gabriel 1', expectedLastPullUTC: 'soon' }]))
      .toThrow('invalid_expectedLastPullUTC');
  });

  it('requires evidence for every well — one bad entry rejects the batch', () => {
    expect(() => parseEmergencyWellDownTargets([
      { wellName: 'Gabriel 1', expectedLastPullUTC: PULL },
      { wellName: 'Gabriel 2' },
    ])).toThrow('invalid_expectedLastPullUTC');
  });
});
