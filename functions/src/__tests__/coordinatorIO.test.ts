// The real RTDB adapter, exercised end-to-end through runCanonicalMutation with
// an in-memory Firebase-like store (ref/once/transaction/update).
import { makeCoordinatorIO, type DbLike, type RefLike } from '../coordinatorIO';
import { runCanonicalMutation, type CommitReceipt, type MutationRequest } from '../chronoCommitCoordinator';
import { receiptPathFor } from '../canonicalPatch';

// Minimal in-memory RTDB: paths are '/'-joined keys into a nested object.
function makeMemDb(): { db: DbLike; store: Record<string, unknown> } {
  const store: Record<string, unknown> = {};
  const get = (path: string): unknown => (path === '' ? store : store[path]);
  const set = (path: string, val: unknown) => { if (val === null) delete store[path]; else store[path] = val; };
  const db: DbLike = {
    ref(path = '') {
      const ref: RefLike = {
        async once() { return { val: () => get(path) }; },
        async transaction(update) {
          const cur = get(path);
          const next = update(cur);
          if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
          set(path, next);
          return { committed: true, snapshot: { val: () => next } };
        },
        async update(values) {
          for (const [k, v] of Object.entries(values)) set(k, v); // flat multi-path
          return undefined;
        },
      };
      return ref;
    },
  };
  return { db, store };
}

const WELL = 'Gabriel 5';
const receipt = (op: string): CommitReceipt => ({
  operationId: op, mutationType: 'backdated_create', wellName: WELL, fence: 1, revision: 1,
  affectedPacketIds: ['p1'], committedAtMs: 0, patchHash: 'h',
});

const req = (op: string): MutationRequest => ({
  wellName: WELL, operationId: op,
  buildPatch: async () => ({
    patch: { 'packets/processed/p1/recoveryInches': 13, [receiptPathFor(WELL, op)]: receipt(op) },
    receipt: receipt(op),
  }),
});

describe('makeCoordinatorIO + runCanonicalMutation (in-memory RTDB)', () => {
  test('commits the atomic patch incl. receipt; releases the lock; is idempotent', async () => {
    const { db, store } = makeMemDb();
    const io = makeCoordinatorIO(db, WELL);

    const out = await runCanonicalMutation(io, req('op1'));
    expect(out.status).toBe('committed');
    expect(store['packets/processed/p1/recoveryInches']).toBe(13);
    expect(store[receiptPathFor(WELL, 'op1')]).toBeTruthy();
    expect(store['wells/Gabriel 5/status/chronoLock']).toBeUndefined(); // released (node cleared)

    // Re-run same op → receipt present → already_done, no change.
    const before = { ...store };
    const again = await runCanonicalMutation(makeCoordinatorIO(db, WELL), req('op1'));
    expect(again.status).toBe('already_done');
    expect(store).toEqual(before);
  });

  test('authorized DELETE-not-found: receipted terminal no-op, replay + collision idempotent', async () => {
    const { db, store } = makeMemDb();
    const targetId = 'gone123';
    const op = `delete_${targetId}`;
    // Mirror the handler's not-found buildPatch: audit archive + incoming null +
    // receipt (affectedPacketIds []), NO processed row change, NO well-state change.
    const notFoundReq = (incomingId: string, auditResult: string): MutationRequest => ({
      wellName: WELL, operationId: op,
      buildPatch: async () => {
        const rec: CommitReceipt = { operationId: op, mutationType: 'delete', wellName: WELL, fence: 1, revision: 1, affectedPacketIds: [], committedAtMs: 0, patchHash: `${op}:1:notfound` };
        return {
          patch: {
            [`packets/processed/delete_${targetId}`]: { result: auditResult },
            [`packets/incoming/${incomingId}`]: null,
            [receiptPathFor(WELL, op)]: rec,
          },
          receipt: rec,
        };
      },
    });

    // First execution → committed; receipt present; no well current/outgoing/status.
    const first = await runCanonicalMutation(makeCoordinatorIO(db, WELL), notFoundReq('inc_A', 'packet_not_found'));
    expect(first.status).toBe('committed');
    expect(store[receiptPathFor(WELL, op)]).toBeTruthy();
    expect((store[receiptPathFor(WELL, op)] as CommitReceipt).affectedPacketIds).toEqual([]);
    expect(store[`packets/processed/delete_${targetId}`]).toEqual({ result: 'packet_not_found' });
    expect(Object.keys(store).some((k) => k.includes('/outgoing/') || k.endsWith('/current'))).toBe(false);

    // Same-id replay → already_done, no change (idempotent by operationId).
    const before = JSON.stringify(store);
    const replay = await runCanonicalMutation(makeCoordinatorIO(db, WELL), notFoundReq('inc_B', 'packet_not_found'));
    expect(replay.status).toBe('already_done');
    expect(JSON.stringify(store)).toBe(before);

    // Same-target/different-request collision → SAME operationId → already_done.
    const collision = await runCanonicalMutation(makeCoordinatorIO(db, WELL), notFoundReq('inc_C', 'DIFFERENT_material'));
    expect(collision.status).toBe('already_done');
    expect(store[`packets/processed/delete_${targetId}`]).toEqual({ result: 'packet_not_found' }); // first result stands
  });

  test('a second op while the first holds the lock is contended (serialized)', async () => {
    const { db, store } = makeMemDb();
    // Pre-seed a live committing lock held by someone else.
    store['wells/Gabriel 5/status/chronoLock'] = { token: 'other', fence: 1, phase: 'committing', at: Date.now(), operationId: 'opX' };
    const out = await runCanonicalMutation(makeCoordinatorIO(db, WELL), req('op2'));
    expect(out.status).toBe('contended');
  });
});
