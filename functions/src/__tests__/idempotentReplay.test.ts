// Exact-ID idempotency proofs: a same-ID replay of an already-processed
// pull is a successful retry, never stale, never rejected; a materially
// conflicting same-ID payload is a collision, quarantined without touching
// processed data.
import * as fs from 'fs';
import * as path from 'path';
import {
  RootRefLike,
  comparePullEquivalence,
  editAlreadyApplied,
  packetIdCollisionVerdict,
  removeIncomingPacket,
} from '../packetGuards';

const PID = '20260722_140214_Gunslinger3_2wvtd1';

/** The already-processed record (CF-enriched). */
const processed = {
  packetId: PID,
  requestType: 'pull',
  wellName: 'Gunslinger 3',
  driverId: 'fd5e1e99da0d3518c7ba9463f9c1cfe81f629242ccbf19d72726d3e9c9a19ec5',
  dateTimeUTC: '2026-07-21T17:06:00.000Z',
  tankLevelFeet: 11.583333333333334,
  tankTopInches: 139,
  bblsTaken: 170,
  processedAt: '2026-07-22T19:02:17.988Z',
  flowRate: '0:22:50',
  tankAfterInches: 108.67567567567568,
};

/** A faithful client replay: same material fields, only bookkeeping extras. */
const replay = {
  packetId: PID,
  requestType: 'pull',
  wellName: 'Gunslinger 3',
  driverId: 'fd5e1e99da0d3518c7ba9463f9c1cfe81f629242ccbf19d72726d3e9c9a19ec5',
  dateTimeUTC: '2026-07-21T17:06:00.000Z',
  tankLevelFeet: 11.583333333333334,
  bblsTaken: 170,
  timezone: 'America/Chicago',
  _retriggeredBy: 'watchdog',
  predictedLevelInches: 140,
};

describe('comparePullEquivalence — material fields only', () => {
  test('exact replay is equivalent despite enrichment/bookkeeping extras', () => {
    const v = comparePullEquivalence(replay, processed);
    expect(v.equivalent).toBe(true);
    expect(v.differences).toEqual([]);
  });

  test('top level equivalence bridges tankLevelFeet vs tankTopInches representations', () => {
    const v = comparePullEquivalence(
      { ...replay, tankLevelFeet: undefined, tankTopInches: 139 },
      processed,
    );
    expect(v.equivalent).toBe(true);
  });

  test('each material conflict is detected with comparison context', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['bblsTaken', { ...replay, bblsTaken: 185 }],
      ['topLevelInches', { ...replay, tankLevelFeet: 9.166666666666666 }],
      ['dateTimeUTC', { ...replay, dateTimeUTC: '2026-07-21T18:01:00.000Z' }],
      ['wellName', { ...replay, wellName: 'Gunslinger 5' }],
      ['driverId', { ...replay, driverId: 'someone-else' }],
      ['requestType', { ...replay, requestType: 'edit' }],
    ];
    for (const [field, incoming] of cases) {
      const v = comparePullEquivalence(incoming, processed);
      expect(v.equivalent).toBe(false);
      expect(v.differences.join(' ')).toContain(field);
    }
  });

  test('collision verdict quarantines with PACKET_ID_COLLISION and preserves context', () => {
    const v = comparePullEquivalence({ ...replay, bblsTaken: 185 }, processed);
    const verdict = packetIdCollisionVerdict(v.differences);
    expect(verdict.action).toBe('quarantine');
    expect(verdict.reason).toBe('PACKET_ID_COLLISION');
    expect(verdict.readableReason).toContain('processed data untouched');
    expect(verdict.readableReason).toContain('bblsTaken');
    expect(verdict.readableReason).toContain('185');
    expect(verdict.readableReason).toContain('170');
  });
});

describe('removeIncomingPacket — atomic duplicate cleanup', () => {
  test('removes ONLY the incoming copy in one update', async () => {
    const calls: Record<string, unknown>[] = [];
    const rootRef: RootRefLike = { update: async (v) => { calls.push(v); } };
    expect(await removeIncomingPacket(rootRef, PID)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ [`packets/incoming/${PID}`]: null });
  });

  test('a failed cleanup leaves incoming intact (no fallback, retried later)', async () => {
    const update = jest.fn().mockRejectedValue(new Error('rtdb unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await removeIncomingPacket({ update }, PID)).toBe(false);
    consoleError.mockRestore();
    expect(update).toHaveBeenCalledTimes(1); // one atomic attempt, nothing else
  });
});

describe('editAlreadyApplied — provable duplicate edit replays', () => {
  const editPacket = {
    requestType: 'edit',
    originalPacketId: PID,
    wellName: 'Gunslinger 3',
    tankLevelFeet: 11.583333333333334,
    bblsTaken: 165,
    wellDown: false,
    dateTimeUTC: '',
  };

  test('provably applied: original has editedAt and values already match', () => {
    const orig = { ...processed, editedAt: '2026-07-22T20:00:00.000Z', bblsTaken: 165, tankTopInches: 139, wellDown: false };
    expect(editAlreadyApplied(editPacket, orig)).toBe(true);
  });

  test('not applied: no edit marker on the original', () => {
    expect(editAlreadyApplied(editPacket, processed)).toBe(false);
  });

  test('not applied: values differ from the edit request', () => {
    const orig = { ...processed, editedAt: '2026-07-22T20:00:00.000Z', bblsTaken: 170 };
    expect(editAlreadyApplied(editPacket, orig)).toBe(false);
  });

  test('unprovable schema returns null (caller proceeds; limitation reported, not guessed)', () => {
    const orig = { ...processed, editedAt: '2026-07-22T20:00:00.000Z', bblsTaken: undefined, tankTopInches: undefined, tankLevelFeet: undefined };
    expect(editAlreadyApplied({ ...editPacket, tankLevelFeet: undefined }, orig)).toBeNull();
  });
});

describe('wiring: idempotency precedes every guard; no re-processing paths', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
  const pullHandler = src.slice(
    src.indexOf('export const processIncomingPull'),
    src.indexOf('export const processEditRequest'),
  );

  test('already-processed check runs BEFORE the future/stale guard ladder', () => {
    const idemIdx = pullHandler.indexOf('alreadyProcessedSnap');
    const guardIdx = pullHandler.indexOf('evaluateIncomingPull({');
    expect(idemIdx).toBeGreaterThan(-1);
    expect(idemIdx).toBeLessThan(guardIdx);   // before stale/future guards
    // Completion audit: NO pre-commit state write exists anymore — the early
    // isDown write was removed; the atomic patch owns every state change.
    expect(pullHandler).not.toContain('status/isDown`).set');
  });

  test('equivalent replay path removes incoming and returns — no enrichment, no outgoing rewrite, no quarantine', () => {
    const idemIdx = pullHandler.indexOf('equivalence.equivalent');
    const block = pullHandler.slice(idemIdx, idemIdx + 1200);
    expect(block).toContain('IDEMPOTENT_REPLAY_ALREADY_PROCESSED');
    expect(block).toContain('removeIncomingPacket(');
    expect(block).toContain('return null;');
    // Never regress the watermark or duplicate effects: no outgoing WRITE
    // and no enrichment calls in the replay path (the comment may mention
    // outgoing, but no db.ref against it exists here).
    expect(block).not.toMatch(/db\.ref\([^)]*outgoing/);
    expect(block).not.toContain('writeProductionLog');
    expect(block).not.toContain('writePerformanceData');
    expect(block).not.toContain('copyToProcessed');
  });

  test('conflicting same-ID payload quarantines as PACKET_ID_COLLISION', () => {
    expect(pullHandler).toContain('packetIdCollisionVerdict(');
  });

  test('edit handler checks provable duplicate application after loading the original', () => {
    const editHandler = src.slice(src.indexOf('export const processEditRequest'));
    const dupIdx = editHandler.indexOf('editAlreadyApplied(');
    const applyIdx = editHandler.indexOf('Apply edits');
    expect(dupIdx).toBeGreaterThan(-1);
    expect(dupIdx).toBeLessThan(applyIdx); // proven duplicates never re-apply
  });
});
