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

  test('a second op while the first holds the lock is contended (serialized)', async () => {
    const { db, store } = makeMemDb();
    // Pre-seed a live committing lock held by someone else.
    store['wells/Gabriel 5/status/chronoLock'] = { token: 'other', fence: 1, phase: 'committing', at: Date.now(), operationId: 'opX' };
    const out = await runCanonicalMutation(makeCoordinatorIO(db, WELL), req('op2'));
    expect(out.status).toBe('contended');
  });
});
