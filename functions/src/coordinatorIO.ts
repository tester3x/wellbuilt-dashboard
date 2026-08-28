// coordinatorIO.ts — the real RTDB adapter for CoordinatorIO. Bridges the pure
// serialized coordinator (chronoCommitCoordinator) to Firebase RTDB: the lock is
// a per-well node mutated by a transaction (CAS); the receipt is read from its
// canonical path; the commit is ONE db.ref().update() of the whole atomic patch.
//
// Injected `DbLike` (a minimal admin.database.Database surface) so this unit
// tests without an emulator; index.ts passes the real db.
import type { CoordinatorIO, LockRecord, CommitReceipt } from './chronoCommitCoordinator';
import { receiptPathFor } from './canonicalPatch';

export interface RefLike {
  once(evt: 'value'): Promise<{ val(): unknown }>;
  transaction(update: (cur: unknown) => unknown): Promise<{ committed: boolean; snapshot: { val(): unknown } }>;
  update(values: Record<string, unknown>): Promise<unknown>;
}
export interface DbLike {
  ref(path?: string): RefLike;
}

let _tokenCounter = 0;

export function makeCoordinatorIO(db: DbLike, wellName: string): CoordinatorIO {
  const lockRef = db.ref(`wells/${wellName}/status/chronoLock`);
  return {
    now: () => Date.now(),
    newToken: () => `${wellName}_${Date.now()}_${(_tokenCounter = (_tokenCounter + 1) % 1e9)}_${Math.floor(Math.random() * 1e9)}`,

    readLock: async () => ((await lockRef.once('value')).val() as LockRecord | null) ?? null,

    casLock: async (_well, apply) => {
      let aborted = false;
      const res = await lockRef.transaction((cur) => {
        const next = apply((cur as LockRecord | null) ?? null);
        if (next === undefined) { aborted = true; return undefined; } // abort
        return next;
      });
      if (!res.committed || aborted) return { ok: false };
      return { ok: true, value: (res.snapshot.val() as LockRecord | null) ?? null };
    },

    readReceipt: async (well, operationId) =>
      ((await db.ref(receiptPathFor(well, operationId)).once('value')).val() as CommitReceipt | null) ?? null,

    // ONE atomic multi-location update — the whole canonical patch incl. receipt.
    commitAtomic: async (patch) => { await db.ref().update(patch); },
  };
}
