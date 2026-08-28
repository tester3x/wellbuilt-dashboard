// Chronological recomputation engine — Gabriel 5 regression + matrix.
import {
  recomputeWell, orderChrono, upsertPull, currentPull, computeBottomInches, planBackdatedCommit, classifyPullPair,
  type ChronoPullInput, type WellChronoConfig,
} from '../chronoRecompute';

const CFG: WellChronoConfig = { bblPerFoot: 20, tanks: 1, allowedBottomInches: 36, avgFlowRateDays: 0.1443 };

const pull = (over: Partial<ChronoPullInput> & { packetId: string; dateTimeUTC: string }): ChronoPullInput => ({
  tankTopInches: 0, bblsTaken: 0, ...over,
});

// ── Gabriel 5 exact regression fixture (packet 18462) ──────────────────────
const PRED_825 = pull({ packetId: '20260825_135400_Gabriel5_pred', dateTimeUTC: '2026-08-25T18:54:00.000Z', knownBottomInches: 66 });
const PULL_101PM = pull({ packetId: '20260826_130158_Gabriel5_existing', dateTimeUTC: '2026-08-26T18:01:07.025Z', tankTopInches: 158, bblsTaken: 145 });
const AM_CREATE = pull({ packetId: '20260827_062211_Gabriel5_lbuegt', dateTimeUTC: '2026-08-26T12:39:00.000Z', tankTopInches: 84, bblsTaken: 60 });
const PM_EDIT_UTC = '2026-08-27T00:39:00.000Z';

describe('Gabriel 5 — late AM CREATE accepted + inserted chronologically', () => {
  const res = recomputeWell([PRED_825, PULL_101PM, AM_CREATE], CFG);
  const byId = (id: string) => res.find((r) => r.packetId === id)!;

  test('AM row inserted BEFORE the 1:01 PM row (event-time order)', () => {
    expect(res.map((r) => r.packetId)).toEqual([PRED_825.packetId, AM_CREATE.packetId, PULL_101PM.packetId]);
    expect(byId(AM_CREATE.packetId).order).toBeLessThan(byId(PULL_101PM.packetId).order);
  });
  test('AM tagged Late Entry and Anomaly/Needs Review; nothing rejected', () => {
    expect(byId(AM_CREATE.packetId).lateEntry).toBe(true);
    expect(byId(AM_CREATE.packetId).anomaly || byId(PULL_101PM.packetId).anomaly).toBe(true);
    expect(res).toHaveLength(3); // all present — none dropped/rejected
  });
  test('current remains the 1:01 PM pull (newest by event time); watermark not regressed', () => {
    expect(currentPull(res)!.packetId).toBe(PULL_101PM.packetId);
    expect(byId(PULL_101PM.packetId).isCurrent).toBe(true);
    expect(byId(AM_CREATE.packetId).isCurrent).toBe(false);
  });
  test('1:01 PM row recomputed against the inserted predecessor (bottom 48 → recovery 110)', () => {
    expect(byId(AM_CREATE.packetId).tankAfterInches).toBe(48);
    expect(byId(PULL_101PM.packetId).recoveryInches).toBe(158 - 48); // 110
  });
});

describe('Gabriel 5 — edit the same logical pull AM→PM', () => {
  const afterCreate = [PRED_825, PULL_101PM, AM_CREATE];
  const edited = upsertPull(afterCreate, { ...AM_CREATE, dateTimeUTC: PM_EDIT_UTC }); // same packetId, new time
  const res = recomputeWell(edited, CFG);
  const byId = (id: string) => res.find((r) => r.packetId === id)!;

  test('the same logical pull moves AFTER the 1:01 PM row', () => {
    expect(res.map((r) => r.packetId)).toEqual([PRED_825.packetId, PULL_101PM.packetId, AM_CREATE.packetId]);
  });
  test('1:01 PM recovery restores to 92 inches (predecessor back to 8/25)', () => {
    expect(byId(PULL_101PM.packetId).recoveryInches).toBe(92);
  });
  test('edited PM pull recovery = 84 − 71 = 13 inches', () => {
    expect(byId(PULL_101PM.packetId).tankAfterInches).toBe(71);
    expect(byId(AM_CREATE.packetId).recoveryInches).toBe(13);
  });
  test('PM pull becomes current', () => {
    expect(byId(AM_CREATE.packetId).isCurrent).toBe(true);
    expect(currentPull(res)!.packetId).toBe(AM_CREATE.packetId);
  });
  test('exactly one logical 60-BBL pull (upsert replaced, not duplicated)', () => {
    expect(res.filter((r) => r.bblsTaken === 60)).toHaveLength(1);
    expect(res).toHaveLength(3);
  });
  test('anomaly recalculated → cleared once the corrected sequence is consistent', () => {
    expect(byId(PULL_101PM.packetId).anomaly).toBe(false);
    expect(byId(AM_CREATE.packetId).anomaly).toBe(false);
  });
});

// ── Matrix ─────────────────────────────────────────────────────────────────
describe('matrix — inserts and edits across multiple successors', () => {
  const P = (id: string, t: string, top: number, bbls: number) => pull({ packetId: id, dateTimeUTC: t, tankTopInches: top, bblsTaken: bbls });

  test('older CREATE with one later pull → inserted before; later recomputed; current = later', () => {
    const later = P('b', '2026-08-26T18:00:00Z', 158, 145);
    const older = P('a', '2026-08-26T06:00:00Z', 84, 60);
    const res = recomputeWell([later, older], { ...CFG });
    expect(res.map((r) => r.packetId)).toEqual(['a', 'b']);
    expect(currentPull(res)!.packetId).toBe('b');
    expect(res.find((r) => r.packetId === 'a')!.lateEntry).toBe(true);
  });

  test('older CREATE with several later pulls → ALL successors recomputed', () => {
    const seed = pull({ packetId: 's', dateTimeUTC: '2026-08-25T00:00:00Z', knownBottomInches: 40 });
    const later1 = P('c', '2026-08-26T00:00:00Z', 120, 100);
    const later2 = P('d', '2026-08-27T00:00:00Z', 150, 120);
    const older = P('b', '2026-08-25T12:00:00Z', 90, 80);
    const res = recomputeWell([seed, later1, later2, older], CFG);
    expect(res.map((r) => r.packetId)).toEqual(['s', 'b', 'c', 'd']);
    // b bottom = 90-(80/20)*12 = 90-48 = 42; c recovery = 120-42 = 78 (recomputed against b, not seed)
    expect(res.find((r) => r.packetId === 'b')!.tankAfterInches).toBe(42);
    expect(res.find((r) => r.packetId === 'c')!.recoveryInches).toBe(120 - 42);
    // d recovers against c bottom = 120-(100/20)*12 = 60 → 150-60 = 90
    expect(res.find((r) => r.packetId === 'd')!.recoveryInches).toBe(150 - 60);
    expect(currentPull(res)!.packetId).toBe('d');
  });

  test('edit moving a pull EARLIER across several pulls re-sorts + recomputes', () => {
    const a = P('a', '2026-08-26T00:00:00Z', 100, 60);
    const b = P('b', '2026-08-26T12:00:00Z', 130, 80);
    const c = P('c', '2026-08-27T00:00:00Z', 160, 100);
    const movedC = { ...c, dateTimeUTC: '2026-08-25T00:00:00Z' }; // c now earliest
    const res = recomputeWell(upsertPull([a, b, c], movedC), CFG);
    expect(res.map((r) => r.packetId)).toEqual(['c', 'a', 'b']);
    expect(currentPull(res)!.packetId).toBe('b'); // c no longer current
    expect(res.find((r) => r.packetId === 'c')!.isCurrent).toBe(false);
  });

  test('edit moving a pull LATER makes it current; a historical edit does not', () => {
    const a = P('a', '2026-08-26T00:00:00Z', 100, 60);
    const b = P('b', '2026-08-26T12:00:00Z', 130, 80);
    const later = recomputeWell(upsertPull([a, b], { ...a, dateTimeUTC: '2026-08-27T00:00:00Z' }), CFG);
    expect(currentPull(later)!.packetId).toBe('a'); // a moved newest → current
    const historical = recomputeWell(upsertPull([a, b], { ...a, dateTimeUTC: '2026-08-26T06:00:00Z' }), CFG);
    expect(currentPull(historical)!.packetId).toBe('b'); // a still historical
  });

  test('simultaneous trucks: reverse arrival order → sequenced by EVENT time, not arrival', () => {
    const early = pull({ packetId: 'truckA', dateTimeUTC: '2026-08-26T10:00:00Z', tankTopInches: 100, bblsTaken: 60, submittedAtMs: 2000 }); // started earlier, submitted LATER
    const late = pull({ packetId: 'truckB', dateTimeUTC: '2026-08-26T11:00:00Z', tankTopInches: 120, bblsTaken: 40, submittedAtMs: 1000 }); // started later, submitted FIRST
    const res = recomputeWell([late, early], CFG);
    expect(res.map((r) => r.packetId)).toEqual(['truckA', 'truckB']); // event-time order, ignores submit
    expect(currentPull(res)!.packetId).toBe('truckB');
  });

  test('identical timestamps → deterministic packetId tie-break', () => {
    const x = P('zzz', '2026-08-26T10:00:00Z', 100, 60);
    const y = P('aaa', '2026-08-26T10:00:00Z', 110, 40);
    expect(orderChrono([x, y]).map((r) => r.packetId)).toEqual(['aaa', 'zzz']);
    expect(orderChrono([y, x]).map((r) => r.packetId)).toEqual(['aaa', 'zzz']); // stable regardless of input order
  });

  test('duplicate replay (same id, same values) stays exactly one row', () => {
    const a = P('a', '2026-08-26T00:00:00Z', 100, 60);
    const res = recomputeWell(upsertPull([a], { ...a }), CFG);
    expect(res).toHaveLength(1);
  });

  test('current watermark never regresses when an older pull is inserted', () => {
    const newest = P('new', '2026-08-27T00:00:00Z', 150, 100);
    const before = currentPull(recomputeWell([newest], CFG))!.packetId;
    const older = P('old', '2026-08-20T00:00:00Z', 90, 60);
    const after = currentPull(recomputeWell([newest, older], CFG))!.packetId;
    expect(before).toBe('new');
    expect(after).toBe('new'); // unchanged
  });

  test('anomaly warns but never rejects (unusual data still present)', () => {
    const seed = pull({ packetId: 's', dateTimeUTC: '2026-08-26T00:00:00Z', knownBottomInches: 60 });
    const weird = P('w', '2026-08-26T00:30:00Z', 180, 20); // huge recovery in 30 min
    const res = recomputeWell([seed, weird], CFG);
    expect(res.find((r) => r.packetId === 'w')!.anomaly).toBe(true);
    expect(res).toHaveLength(2); // not dropped
  });

  test('computeBottomInches matches the historical formula', () => {
    expect(computeBottomInches(158, 145, CFG)).toBe(71); // 158 - (145/20)*12
  });
});

describe('planBackdatedCommit — atomic single-update, no watermark regression', () => {
  const before = recomputeWell([PRED_825, PULL_101PM], CFG);
  const after = recomputeWell([PRED_825, PULL_101PM, AM_CREATE], CFG);

  test('writes the new row + ONLY changed successors; current pointer unchanged', () => {
    const plan = planBackdatedCommit({ before, after, newPacketId: AM_CREATE.packetId, wellRevision: 7 });
    // current stays the 1:01 PM pull; watermark not regressed.
    expect(plan.currentPacketId).toBe(PULL_101PM.packetId);
    expect(plan.watermarkRegressed).toBe(false);
    expect(plan.insertedLateEntry).toBe(true);
    // The predecessor 8/25 did not change; the 1:01 PM successor DID (recovery 92→110).
    expect(plan.changedPacketIds).toEqual([PULL_101PM.packetId]);
    expect(plan.updates[`packets/processed/${AM_CREATE.packetId}/recoveryInches`]).toBe(18);
    expect(plan.updates[`packets/processed/${PULL_101PM.packetId}/recoveryInches`]).toBe(110);
    // no write touches the untouched predecessor
    expect(plan.updates[`packets/processed/${PRED_825.packetId}/recoveryInches`]).toBeUndefined();
    // every touched row carries the fencing revision
    expect(plan.updates[`packets/processed/${AM_CREATE.packetId}/chronoRevision`]).toBe(7);
    expect(plan.updates[`packets/processed/${PULL_101PM.packetId}/chronoRevision`]).toBe(7);
    // NEVER writes outgoing/current (watermark owner) in the update map
    expect(Object.keys(plan.updates).some((k) => k.startsWith('packets/outgoing'))).toBe(false);
  });

  test('PROVEN duplicate (shared operationId) → idempotent no-op', () => {
    const provenDup = { ...AM_CREATE, packetId: '20260827_999999_Gabriel5_dupe', operationId: 'op-shared', };
    const amWithOp = { ...AM_CREATE, operationId: 'op-shared' };
    const before2 = recomputeWell([PRED_825, PULL_101PM, amWithOp], CFG);
    const afterDup = recomputeWell([PRED_825, PULL_101PM, amWithOp, provenDup], CFG);
    const plan = planBackdatedCommit({ before: before2, after: afterDup, newPacketId: provenDup.packetId, wellRevision: 8 });
    expect(plan.duplicateNoop).toBe(true);
    expect(Object.keys(plan.updates)).toHaveLength(0);
  });

  test('value-match WITHOUT provenance → NOT a no-op: accepted + Potential Duplicate', () => {
    const lookalike = { ...AM_CREATE, packetId: '20260827_999999_Gabriel5_diff' }; // same values, distinct id, no provenance
    const afterDup = recomputeWell([PRED_825, PULL_101PM, AM_CREATE, lookalike], CFG);
    const plan = planBackdatedCommit({ before: after, after: afterDup, newPacketId: lookalike.packetId, wellRevision: 8 });
    expect(plan.duplicateNoop).toBe(false);
    expect(plan.potentialDuplicate).toBe(true);
    expect(plan.updates[`packets/processed/${lookalike.packetId}/potentialDuplicate`]).toBe(true);
  });
});

describe('potential duplicate — reversed arrival, neither pull disappears', () => {
  const P = (id: string, t: string, top: number, bbls: number) => pull({ packetId: id, dateTimeUTC: t, tankTopInches: top, bblsTaken: bbls });
  const a = P('truckA', '2026-08-26T10:00:00Z', 100, 60);
  const b = P('truckB', '2026-08-26T10:00:00Z', 100, 60); // identical time+values, distinct id

  test('both arrival orders → both present, both flagged potential_duplicate, deterministic order', () => {
    const r1 = recomputeWell([a, b], CFG);
    const r2 = recomputeWell([b, a], CFG);
    expect(r1.map((r) => r.packetId)).toEqual(['truckA', 'truckB']); // packetId tie-break
    expect(r2.map((r) => r.packetId)).toEqual(['truckA', 'truckB']); // identical regardless of input order
    expect(r1.length).toBe(2);
    expect(r1.every((r) => r.potentialDuplicate)).toBe(true);
    expect(r1.every((r) => r.anomalyReasons.includes('potential_duplicate'))).toBe(true);
  });

  test('shared operationId + EQUIVALENT material → proven duplicate (not flagged potential)', () => {
    const a2 = { ...a, operationId: 'op-1' };
    const b2 = { ...b, operationId: 'op-1' }; // same time+values + same lineage
    const r = recomputeWell([a2, b2], CFG);
    expect(r.every((x) => x.potentialDuplicate)).toBe(false);
    expect(r.every((x) => x.needsReview)).toBe(false);
  });
});

describe('provenance verdicts — lineage is NOT material equivalence', () => {
  const base = { packetId: 'x', dateTimeUTC: '2026-08-26T10:00:00Z', tankTopInches: 100, bblsTaken: 60 } as ChronoPullInput;

  test('classifyPullPair full verdict table', () => {
    expect(classifyPullPair(base, { ...base })).toBe('replay');                                  // same id, equiv
    expect(classifyPullPair(base, { ...base, bblsTaken: 70 })).toBe('collision');                // same id, diff
    expect(classifyPullPair({ ...base, packetId: 'a', operationId: 'op' }, { ...base, packetId: 'b', operationId: 'op' })).toBe('proven_duplicate'); // diff id, lineage, equiv
    expect(classifyPullPair({ ...base, packetId: 'a', operationId: 'op' }, { ...base, packetId: 'b', operationId: 'op', bblsTaken: 75 })).toBe('correction_conflict'); // diff id, lineage, DIFF material
    expect(classifyPullPair({ ...base, packetId: 'a' }, { ...base, packetId: 'b' })).toBe('potential_duplicate'); // diff id, values match, no lineage
    expect(classifyPullPair({ ...base, packetId: 'a' }, { ...base, packetId: 'b', bblsTaken: 99 })).toBe('distinct'); // diff id, distinct
  });

  test('multiple corrections sharing operationId with DIFFERENT material all survive + Needs Review (never a silent no-op)', () => {
    const attempt1 = { packetId: 'r1', dateTimeUTC: '2026-08-26T10:00:00Z', tankTopInches: 100, bblsTaken: 60, operationId: 'recover-op' } as ChronoPullInput;
    const attempt2 = { packetId: 'r2', dateTimeUTC: '2026-08-26T11:00:00Z', tankTopInches: 100, bblsTaken: 75, operationId: 'recover-op' } as ChronoPullInput; // later, different time+bbls
    const r = recomputeWell([attempt1, attempt2], CFG);
    expect(r).toHaveLength(2);                                  // neither dropped
    expect(r.find((x) => x.packetId === 'r1')!.needsReview).toBe(true);
    expect(r.find((x) => x.packetId === 'r2')!.needsReview).toBe(true);
    expect(r.some((x) => x.anomalyReasons.includes('lineage_material_conflict'))).toBe(true);
  });

  test('planBackdatedCommit no-op ONLY on proven duplicate (lineage + equivalent material)', () => {
    const existing = { packetId: 'e', dateTimeUTC: '2026-08-26T10:00:00Z', tankTopInches: 100, bblsTaken: 60, operationId: 'op' } as ChronoPullInput;
    const equivDup = { packetId: 'n', dateTimeUTC: '2026-08-26T10:00:00Z', tankTopInches: 100, bblsTaken: 60, operationId: 'op' } as ChronoPullInput; // lineage + equiv → no-op
    const conflict = { packetId: 'n', dateTimeUTC: '2026-08-26T10:00:00Z', tankTopInches: 100, bblsTaken: 99, operationId: 'op' } as ChronoPullInput; // lineage + DIFF → accept + review
    const before = recomputeWell([existing], CFG);
    const p1 = planBackdatedCommit({ before, after: recomputeWell(upsertPull([existing], equivDup), CFG), newPacketId: 'n', wellRevision: 1 });
    expect(p1.duplicateNoop).toBe(true);
    const p2 = planBackdatedCommit({ before, after: recomputeWell(upsertPull([existing], conflict), CFG), newPacketId: 'n', wellRevision: 1 });
    expect(p2.duplicateNoop).toBe(false);
    expect(p2.needsReview).toBe(true);
  });
});

describe('historical rows retain stored/config-derived bottoms (no recompute with today config)', () => {
  test('a row with knownBottomInches keeps its bottom even under a DIFFERENT bblPerFoot', () => {
    // Existing processed row carries its stored tankAfterInches as knownBottomInches.
    const stored = { packetId: 'old', dateTimeUTC: '2026-08-26T18:01:07.025Z', tankTopInches: 158, bblsTaken: 145, knownBottomInches: 71 } as ChronoPullInput;
    // Recompute under a CHANGED config (bblPerFoot 40, not the original 20).
    const res = recomputeWell([stored], { bblPerFoot: 40, tanks: 2 });
    // Stored bottom preserved (would be 158-(145/40)*12=114.5 if recomputed — it is NOT).
    expect(res[0].tankAfterInches).toBe(71);
  });
  test('a NEW row (no stored bottom) DOES compute with the current config', () => {
    const fresh = { packetId: 'new', dateTimeUTC: '2026-08-27T00:39:00.000Z', tankTopInches: 240, bblsTaken: 100 } as ChronoPullInput;
    const res = recomputeWell([fresh], { bblPerFoot: 200, tanks: 6 }); // Daredevil-style
    expect(res[0].tankAfterInches).toBe(234); // 240 - (100/200)*12
  });
});
