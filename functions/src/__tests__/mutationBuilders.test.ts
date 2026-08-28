// mutationBuilders — proves each builder composes the engine + assembler into ONE
// atomic {patch, receipt} whose receipt is part of the same patch, with the right
// mutationType, current pointer, changed-successor set, and sidecar flow-through.
import { buildCreateMutation, buildEditMutation, buildDeleteMutation, type CanonicalSidecar } from '../mutationBuilders';
import { receiptPathFor } from '../canonicalPatch';
import type { ChronoPullInput, WellChronoConfig } from '../chronoRecompute';

const WELL = 'Gabriel 5';
const cfg: WellChronoConfig = { bblPerFoot: 20, tanks: 1, allowedBottomInches: 30 };

// A: 12:00 top158 bbls145 → bottom 71.  B (newest): 18:00 top100 bbls60 → bottom 64, recovery 100-71=29.
// Both carry STORED lateEntry:false (each was the newest when inserted) so a later
// pull never relabels them — Late Entry is stable provenance, not positional.
const A: ChronoPullInput = { packetId: 'A', dateTimeUTC: '2026-08-27T12:00:00.000Z', tankTopInches: 158, bblsTaken: 145, lateEntry: false };
const B: ChronoPullInput = { packetId: 'B', dateTimeUTC: '2026-08-27T18:00:00.000Z', tankTopInches: 100, bblsTaken: 60, lateEntry: false };

const sidecar: CanonicalSidecar = {
  outgoing: { deleteResponseIds: ['oldResp'], responseId: 'newResp', response: { packetId: 'X' } },
  wellStatus: { wellName: WELL, status: { current: { level: 66 } } },
  afr: { wellName: WELL, avgFlowRate: '0:30', avgFlowRateMinutes: 30 },
};
const common = (op: string) => ({
  wellName: WELL, operationId: op, fence: 7, revision: 7, committedAtMs: 1_756_000_000_000, patchHash: 'h', sidecar,
});

describe('buildCreateMutation', () => {
  test('newest CREATE — mutationType create, isCurrent, no successor changes, receipt in patch', () => {
    const C: ChronoPullInput = { packetId: 'C', dateTimeUTC: '2026-08-27T22:00:00.000Z', tankTopInches: 90, bblsTaken: 40 };
    const { patch, receipt, isCurrent } = buildCreateMutation({
      ...common('op-c'), existingChain: [A, B], newPull: C, cfg,
      newProcessedRecord: { packetId: 'C', dateTimeUTC: C.dateTimeUTC, tankTopInches: 90, bblsTaken: 40, source: 'test' },
    });
    expect(isCurrent).toBe(true);
    expect(receipt.mutationType).toBe('create');
    // Only C is affected: appending a newer pull does NOT relabel B (its stored
    // lateEntry:false is preserved), so B is not rewritten.
    expect(receipt.affectedPacketIds).toEqual(['C']);
    expect(patch['packets/processed/B/lateEntry']).toBeUndefined(); // B untouched
    // Full new record present with derived overlaid.
    const rec = patch['packets/processed/C'] as Record<string, unknown>;
    expect(rec.source).toBe('test');
    expect(rec.tankAfterInches).toBe(66);     // 90 - (40/20)*12 = 66
    expect(rec.recoveryInches).toBe(26);      // 90 - 64
    expect(rec.lateEntry).toBe(false);        // C IS the newest → not late
    expect(rec.chronoRevision).toBe(7);
    // Receipt is part of the SAME patch.
    expect(patch[receiptPathFor(WELL, 'op-c')]).toBe(receipt);
    // Sidecar flowed through.
    expect(patch['packets/outgoing/oldResp']).toBeNull();
    expect(patch['packets/outgoing/newResp']).toEqual({ packetId: 'X' });
    expect(patch['wells/Gabriel 5/status/current']).toEqual({ level: 66 }); // child-key write, not full-node
    expect(patch['wells/Gabriel 5/status']).toBeUndefined();                 // never a full-node set (would wipe lock)
    expect(patch['wells/Gabriel 5/status/chronoRevision']).toBe(7);
    expect(patch['well_config/Gabriel 5/avgFlowRate']).toBe('0:30');
  });

  test('backdated CREATE — mutationType backdated_create, current unchanged, successor recomputed', () => {
    // M at 15:00 between A and B: bottom 120-(30/20)*12 = 102; B recovery becomes max(0,100-102)=0 (was 29).
    const M: ChronoPullInput = { packetId: 'M', dateTimeUTC: '2026-08-27T15:00:00.000Z', tankTopInches: 120, bblsTaken: 30 };
    const { patch, receipt, isCurrent } = buildCreateMutation({
      ...common('op-m'), existingChain: [A, B], newPull: M, cfg,
      newProcessedRecord: { packetId: 'M', dateTimeUTC: M.dateTimeUTC, tankTopInches: 120, bblsTaken: 30 },
    });
    expect(isCurrent).toBe(false);
    expect(receipt.mutationType).toBe('backdated_create');
    expect(receipt.affectedPacketIds).toEqual(['M', 'B']); // B is the changed successor
    // B recomputed as a child-path update (not a full-record overwrite).
    expect(patch['packets/processed/B/recoveryInches']).toBe(0);
    expect(patch['packets/processed/B/chronoRevision']).toBe(7);
    // M full record present.
    expect((patch['packets/processed/M'] as Record<string, unknown>).recoveryInches).toBe(49); // 120-71
    expect(patch[receiptPathFor(WELL, 'op-m')]).toBe(receipt);
  });
});

describe('buildEditMutation', () => {
  test('moving B to newest promotes it to current; edited row material + derived rewritten', () => {
    const C: ChronoPullInput = { packetId: 'C', dateTimeUTC: '2026-08-27T22:00:00.000Z', tankTopInches: 90, bblsTaken: 40 };
    const editedB: ChronoPullInput = { ...B, dateTimeUTC: '2026-08-27T23:30:00.000Z', tankTopInches: 110, bblsTaken: 60 };
    const { patch, receipt, current } = buildEditMutation({
      ...common('op-e'), existingChain: [A, B, C], editedPull: editedB, cfg,
    });
    expect(current).toBe('B');               // B is now newest by event time
    expect(receipt.mutationType).toBe('edit');
    expect(receipt.affectedPacketIds).toContain('B'); // edited row
    expect(receipt.affectedPacketIds).toContain('C'); // C's predecessor changed (was B, now A)
    // Edited row's material change applied.
    expect(patch['packets/processed/B/dateTimeUTC']).toBe('2026-08-27T23:30:00.000Z');
    expect(patch['packets/processed/B/tankTopInches']).toBe(110);
    expect(patch['packets/processed/B/bblsTaken']).toBe(60);
    expect(patch[receiptPathFor(WELL, 'op-e')]).toBe(receipt);
  });
});

describe('buildDeleteMutation', () => {
  test('deleting middle B nulls it and recomputes successor C', () => {
    const C: ChronoPullInput = { packetId: 'C', dateTimeUTC: '2026-08-27T22:00:00.000Z', tankTopInches: 90, bblsTaken: 40 };
    const { patch, receipt, current } = buildDeleteMutation({
      ...common('op-d'), existingChain: [A, B, C], deletePacketId: 'B', cfg,
    });
    expect(current).toBe('C');
    expect(receipt.mutationType).toBe('delete');
    expect(patch['packets/processed/B']).toBeNull();       // removed
    // C's predecessor is now A (bottom 71) → recovery 90-71=19 (was 90-64=26).
    expect(patch['packets/processed/C/recoveryInches']).toBe(19);
    expect(receipt.affectedPacketIds[0]).toBe('B');
    expect(receipt.affectedPacketIds).toContain('C');
    expect(patch[receiptPathFor(WELL, 'op-d')]).toBe(receipt);
  });
});
