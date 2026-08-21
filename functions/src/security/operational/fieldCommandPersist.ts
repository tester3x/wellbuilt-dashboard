/**
 * Production persist adapter for field-command effects.
 *
 * Firestore `set({ ['doneEffects.name']: true }, { merge: true })` writes a
 * LITERAL top-level field named "doneEffects.name". It does not update the
 * nested `doneEffects` map. Recovery that reads `data.doneEffects` then
 * sees an empty map and re-applies — the 16e/16f defect.
 *
 * This adapter always writes the whole nested map object.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import type { FieldEffectName } from './fieldCommandApply';
import {
  decideReleaseLock,
  decideTargetLock,
  nextFenceGeneration,
  verifyFence,
  type FenceOwner,
  type TargetLock,
} from './fieldCommandLease';

export interface SemanticDoc {
  data: Record<string, unknown>;
}

/**
 * Firestore `set(..., { merge: true })` semantics: every key, including
 * keys that contain dots, becomes a literal field name.
 */
export function firestoreSetMerge(
  doc: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...doc, ...patch };
}

/**
 * Firestore `update()` dotted-path semantics (for contrast / tests only).
 * Production persist does NOT use dotted strings.
 */
export function firestoreUpdateDotted(
  doc: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...doc };
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let cur: Record<string, unknown> = next;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        const child = cur[p];
        if (!child || typeof child !== 'object' || Array.isArray(child)) {
          cur[p] = {};
        }
        cur = cur[p] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = value;
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Nested-map patch. Never emits a dotted field name. */
export function persistEffectPatch(
  existingDone: unknown,
  name: FieldEffectName,
): { doneEffects: Record<string, true>; lastEffect: FieldEffectName } {
  const map: Record<string, true> = {};
  if (existingDone && typeof existingDone === 'object' && !Array.isArray(existingDone)) {
    for (const [k, v] of Object.entries(existingDone as Record<string, unknown>)) {
      if (v === true && k && !k.includes('.')) map[k] = true;
    }
  }
  map[name] = true;
  return { doneEffects: map, lastEffect: name };
}

export function readDoneEffects(data: Record<string, unknown> | undefined): Record<string, true> {
  const raw = data?.doneEffects;
  const map: Record<string, true> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === true && k && !k.includes('.')) map[k] = true;
    }
  }
  return map;
}

export interface PersistTxn {
  get(path: string): Promise<Record<string, unknown> | null>;
  set(path: string, data: Record<string, unknown>): Promise<void>;
  update(path: string, data: Record<string, unknown>): Promise<void>;
  delete(path: string): Promise<void>;
  /** Snapshot isolation + retry. Required for acquire/release/transitions. */
  runAtomic<T>(fn: (inner: PersistTxn) => Promise<T>): Promise<T>;
}

async function inAtomic<T>(txn: PersistTxn, fn: (inner: PersistTxn) => Promise<T>): Promise<T> {
  if (typeof txn.runAtomic === 'function') return txn.runAtomic(fn);
  return fn(txn);
}

export async function persistDoneEffectAdmin(
  db: Firestore,
  receiptRef: DocumentReference,
  lockRef: DocumentReference,
  fence: FenceOwner,
  name: FieldEffectName,
  nowMs: number,
): Promise<Record<string, true>> {
  return db.runTransaction(async (tx) => {
    const lockSnap = await tx.get(lockRef);
    const lock: TargetLock = lockSnap.exists
      ? { exists: true, ...(lockSnap.data() as Omit<TargetLock, 'exists'>) }
      : { exists: false };
    if (!verifyFence(lock, { ...fence, nowMs })) {
      throw Object.assign(new Error('stale_fence'), { code: 'stale_fence' });
    }
    const receiptSnap = await tx.get(receiptRef);
    const patch = persistEffectPatch(receiptSnap.data()?.doneEffects, name);
    tx.update(receiptRef, {
      doneEffects: patch.doneEffects,
      lastEffect: patch.lastEffect,
    });
    return patch.doneEffects;
  });
}

export async function persistDoneEffectNested(
  txn: PersistTxn,
  receiptPath: string,
  lockPath: string,
  fence: FenceOwner,
  name: FieldEffectName,
  nowMs: number = Date.now(),
): Promise<Record<string, true>> {
  return inAtomic(txn, async (t) => {
    const lockData = await t.get(lockPath);
    const lock: TargetLock = lockData
      ? {
          exists: true,
          attemptToken: lockData.attemptToken as string | undefined,
          fenceGeneration: lockData.fenceGeneration as number | undefined,
          receiptKey: lockData.receiptKey as string | undefined,
          leaseUntil: lockData.leaseUntil as number | undefined,
          ownerDriverId: lockData.ownerDriverId as string | undefined,
        }
      : { exists: false };
    if (!verifyFence(lock, { ...fence, nowMs })) {
      throw Object.assign(new Error('stale_fence'), { code: 'stale_fence' });
    }
    const receipt = (await t.get(receiptPath)) || {};
    const patch = persistEffectPatch(receipt.doneEffects, name);
    await t.update(receiptPath, {
      doneEffects: patch.doneEffects,
      lastEffect: patch.lastEffect,
    });
    return patch.doneEffects;
  });
}

export async function acquireExclusiveTargetLock(
  txn: PersistTxn,
  lockPath: string,
  input: {
    attemptToken: string;
    nowMs?: number;
    leaseMs: number;
    receiptKey: string;
    ownerDriverId: string;
    companyId: string;
    targetPacketId: string;
    resumeSameReceipt?: boolean;
  },
): Promise<FenceOwner> {
  return inAtomic(txn, async (t) => {
    const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
    const existingData = await t.get(lockPath);
    const existing: TargetLock = existingData
      ? {
          exists: true,
          attemptToken: existingData.attemptToken as string | undefined,
          fenceGeneration: existingData.fenceGeneration as number | undefined,
          receiptKey: existingData.receiptKey as string | undefined,
          leaseUntil: existingData.leaseUntil as number | undefined,
        }
      : { exists: false };
    const dec = decideTargetLock(existing, {
      attemptToken: input.attemptToken,
      nowMs,
      receiptKey: input.receiptKey,
      resumeSameReceipt: input.resumeSameReceipt === true,
    });
    if (dec === 'collision') {
      throw Object.assign(new Error('target_locked'), { code: 'target_locked' });
    }
    const fenceGeneration =
      dec === 'reacquire_same' && typeof existing.fenceGeneration === 'number'
        ? existing.fenceGeneration
        : nextFenceGeneration(existing);
    const next = {
      attemptToken: input.attemptToken,
      fenceGeneration,
      receiptKey: input.receiptKey,
      ownerDriverId: input.ownerDriverId,
      leaseUntil: nowMs + input.leaseMs,
      companyId: input.companyId,
      targetPacketId: input.targetPacketId,
    };
    await t.set(lockPath, next);
    return { attemptToken: input.attemptToken, fenceGeneration };
  });
}

export async function assertFenceLive(
  txn: PersistTxn,
  lockPath: string,
  fence: FenceOwner,
  nowMs: number = Date.now(),
): Promise<void> {
  await inAtomic(txn, async (t) => {
    const lockData = await t.get(lockPath);
    const lock: TargetLock = lockData
      ? {
          exists: true,
          attemptToken: lockData.attemptToken as string | undefined,
          fenceGeneration: lockData.fenceGeneration as number | undefined,
          leaseUntil: lockData.leaseUntil as number | undefined,
        }
      : { exists: false };
    if (!verifyFence(lock, { ...fence, nowMs })) {
      throw Object.assign(new Error('stale_fence'), { code: 'stale_fence' });
    }
  });
}

export async function releaseTargetLockIfOwner(
  txn: PersistTxn,
  lockPath: string,
  fence: FenceOwner,
): Promise<'deleted' | 'refused' | 'missing'> {
  return inAtomic(txn, async (t) => {
    const lockData = await t.get(lockPath);
    const lock: TargetLock = lockData
      ? {
          exists: true,
          attemptToken: lockData.attemptToken as string | undefined,
          fenceGeneration: lockData.fenceGeneration as number | undefined,
        }
      : { exists: false };
    const dec = decideReleaseLock(lock, fence);
    if (dec === 'delete') {
      await t.delete(lockPath);
      return 'deleted';
    }
    if (dec === 'refuse') return 'refused';
    return 'missing';
  });
}

export async function transitionReceiptAtomic(
  txn: PersistTxn,
  receiptPath: string,
  lockPath: string,
  fence: FenceOwner,
  patch: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<void> {
  await inAtomic(txn, async (t) => {
    const lockData = await t.get(lockPath);
    const lock: TargetLock = lockData
      ? {
          exists: true,
          attemptToken: lockData.attemptToken as string | undefined,
          fenceGeneration: lockData.fenceGeneration as number | undefined,
          leaseUntil: lockData.leaseUntil as number | undefined,
        }
      : { exists: false };
    if (!verifyFence(lock, { ...fence, nowMs })) {
      throw Object.assign(new Error('stale_fence'), { code: 'stale_fence' });
    }
    await t.update(receiptPath, patch);
  });
}

/**
 * In-memory Firestore-semantic document store used by unit tests of the
 * exact persist adapter. `setMerge` uses literal keys (including dots).
 * `update` replaces named fields as whole values (no dotted-path expand).
 * This matches how the production adapter writes `doneEffects`.
 */
export function createSemanticFirestore(): {
  docs: Record<string, Record<string, unknown>>;
  txn: PersistTxn;
} {
  const docs: Record<string, Record<string, unknown>> = {};
  let version = 0;
  const makeView = (store: Record<string, Record<string, unknown>>): PersistTxn => ({
    async get(path) {
      return store[path] ? { ...store[path] } : null;
    },
    async set(path, data) {
      store[path] = { ...data };
    },
    async update(path, data) {
      const cur = store[path] ? { ...store[path] } : {};
      store[path] = firestoreSetMerge(cur, data);
    },
    async delete(path) {
      delete store[path];
    },
    async runAtomic(fn) {
      return fn(makeView(store));
    },
  });
  const txn: PersistTxn = {
    async get(path) {
      return docs[path] ? { ...docs[path] } : null;
    },
    async set(path, data) {
      docs[path] = { ...data };
    },
    async update(path, data) {
      const cur = docs[path] ? { ...docs[path] } : {};
      docs[path] = firestoreSetMerge(cur, data);
    },
    async delete(path) {
      delete docs[path];
    },
    async runAtomic(fn) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const start = version;
        const scratch: Record<string, Record<string, unknown>> = {};
        for (const [k, v] of Object.entries(docs)) scratch[k] = { ...v };
        const inner = makeView(scratch);
        const result = await fn(inner);
        if (version !== start) continue;
        for (const key of Object.keys(docs)) {
          if (!(key in scratch)) delete docs[key];
        }
        for (const [k, v] of Object.entries(scratch)) docs[k] = { ...v };
        version += 1;
        return result;
      }
      throw new Error('transaction_retry_exhausted');
    },
  };
  return { docs, txn };
}
