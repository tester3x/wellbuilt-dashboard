// v2 SWAP-READINESS integration test (packet 60427). Demonstrates that the pure
// convergence reducer (materializeV2Correction) composes with assembleCanonicalPatch
// into the ONE complete atomic patch the coordinator's buildPatch will submit —
// WITHOUT wiring the live schema-v2 handler (which still uses fencedSourceWrite until
// the real emulator can verify the swap). This is the exact shape of the future swap:
//   read authoritative snapshot → materializeV2Correction → assemble patch + receipt.
import { materializeV2Correction, type V2MaterializationState } from '../v2Materialization';
import { assembleCanonicalPatch, receiptPathFor } from '../canonicalPatch';
import type { CommitReceipt } from '../chronoCommitCoordinator';
import type { EditableSnapshot } from '../editHistory';

const baseline: EditableSnapshot = { tankTopInches: 100, bblsTaken: 40, dateTimeUTC: '2026-08-27T12:00:00.000Z', dateTime: '8/27 7:00 AM', wellDown: false };

/** The composition the coordinator's buildPatch will perform post-swap. Pure: given
 *  the authoritative row snapshot + the new correction, converge and assemble. */
function buildV2EditPatch(args: {
  wellName: string; originalPacketId: string; editEventId: string; revision: number;
  snapshot: V2MaterializationState & Record<string, unknown>;
  correction: { correctionCreatedAtUTC: string; correctionValues: EditableSnapshot; serverReceivedAtUTC?: string; editSource?: string };
  incomingId: string;
}): { patch: Record<string, unknown>; receipt: CommitReceipt; converged: EditableSnapshot } {
  const mat = materializeV2Correction(args.snapshot, baseline, { editEventId: args.editEventId, ...args.correction });
  const base = `packets/processed/${args.originalPacketId}`;
  const processedUpdates: Record<string, unknown> = {
    [`${base}/editBaseline`]: mat.editBaseline,
    [`${base}/editCorrections`]: mat.editCorrections,
    [`${base}/materializationRev`]: mat.materializationRev,
    [`${base}/bblsTaken`]: mat.fields.bblsTaken,
    [`${base}/tankTopInches`]: mat.fields.tankTopInches,
    [`${base}/dateTimeUTC`]: mat.fields.dateTimeUTC,
    [`${base}/wellDown`]: mat.fields.wellDown,
    [`${base}/editCount`]: mat.editCount,
  };
  const receipt: CommitReceipt = {
    operationId: args.editEventId, mutationType: 'edit', wellName: args.wellName, fence: args.revision, revision: args.revision,
    affectedPacketIds: [args.originalPacketId], committedAtMs: 0, patchHash: `${args.editEventId}:${args.revision}`,
  };
  const patch = assembleCanonicalPatch({
    processedUpdates, fence: { wellName: args.wellName, revision: args.revision },
    receipt, receiptPath: receiptPathFor(args.wellName, args.editEventId),
  });
  // Edit-trail + source-request consumption fold into the SAME patch (as the live swap will).
  patch[`packets/editHistory/${args.originalPacketId}/${args.editEventId}`] = { eventId: args.editEventId };
  patch[`packets/editReceipts/${args.editEventId}`] = { status: 'accepted' };
  patch[`packets/incoming/${args.incomingId}`] = null;
  return { patch, receipt, converged: mat.fields };
}

describe('v2 swap-readiness: materialize → assemble one complete patch', () => {
  const WELL = 'Gabriel 5';
  const run = (snapshot: V2MaterializationState & Record<string, unknown>, editEventId: string, values: EditableSnapshot, incomingId = 'inc1') =>
    buildV2EditPatch({ wellName: WELL, originalPacketId: 'p100', editEventId, revision: 5, snapshot, correction: { correctionCreatedAtUTC: '2026-08-27T13:00:00Z', correctionValues: values, serverReceivedAtUTC: '2026-08-27T13:00:01Z', editSource: 'wbm' }, incomingId });

  test('produces ONE complete patch: converged material + receipt + request consumption', () => {
    const { patch, receipt, converged } = run({}, 'e1', { bblsTaken: 55 });
    expect(converged.bblsTaken).toBe(55);
    // converged material written under the pull's own node
    expect(patch['packets/processed/p100/bblsTaken']).toBe(55);
    expect(patch['packets/processed/p100/materializationRev']).toBe(1);
    expect(patch['packets/processed/p100/editCorrections']).toHaveProperty('e1');
    // receipt in the SAME patch + source request consumed
    expect(patch[receiptPathFor(WELL, 'e1')]).toBe(receipt);
    expect(patch['packets/incoming/inc1']).toBeNull();
    // fence advanced
    expect(patch['wells/Gabriel 5/status/chronoRevision']).toBe(5);
  });

  test('replay of the same correction is idempotent — rev does not advance, patch stable', () => {
    const first = run({}, 'e1', { bblsTaken: 55 });
    const snapshotAfter = {
      editBaseline: first.patch['packets/processed/p100/editBaseline'],
      editCorrections: first.patch['packets/processed/p100/editCorrections'],
      materializationRev: first.patch['packets/processed/p100/materializationRev'],
    } as V2MaterializationState & Record<string, unknown>;
    const replay = run(snapshotAfter, 'e1', { bblsTaken: 55 }, 'inc2');
    expect(replay.patch['packets/processed/p100/materializationRev']).toBe(1); // no advance
    expect(replay.patch['packets/processed/p100/editCorrections']).toEqual(first.patch['packets/processed/p100/editCorrections']);
  });

  test('a second distinct correction preserves the first and advances the rev', () => {
    const first = run({}, 'e1', { bblsTaken: 55 });
    const snap = {
      editCorrections: first.patch['packets/processed/p100/editCorrections'],
      materializationRev: first.patch['packets/processed/p100/materializationRev'],
    } as V2MaterializationState & Record<string, unknown>;
    const second = buildV2EditPatch({ wellName: WELL, originalPacketId: 'p100', editEventId: 'e2', revision: 6, snapshot: snap, correction: { correctionCreatedAtUTC: '2026-08-27T14:00:00Z', correctionValues: { tankTopInches: 120 } }, incomingId: 'inc3' });
    expect(second.patch['packets/processed/p100/materializationRev']).toBe(2);
    expect(second.patch['packets/processed/p100/editCorrections']).toHaveProperty('e1'); // preserved
    expect(second.patch['packets/processed/p100/editCorrections']).toHaveProperty('e2');
    expect(second.converged.tankTopInches).toBe(120);
    expect(second.converged.bblsTaken).toBe(55); // still from e1
  });
});
