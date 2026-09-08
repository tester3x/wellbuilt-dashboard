/**
 * Reconcile pull-owned current-state after a governed delete.
 *
 * processIncomingPull materializes the namespaced node
 * companyWells/{companyId}/{wellKey} = { pullHighWater, materializedPacketId,
 * current } and wells/{well}/status. The legacy processDeleteRequest rebuilt
 * only packets/outgoing + AFR, leaving those pointing at the deleted packet.
 * This module reconciles them:
 *   - current-pull delete with a surviving predecessor → set ownership to the
 *     newest surviving pull and rebuild its pull-owned current state;
 *   - current-pull delete with no survivor → clear only pull-derived fields;
 *   - historical delete → refresh to the (unchanged) latest;
 *   - a concurrent NEWER natural pull that already owns the high-water always
 *     wins (compare-and-set abort; never regress).
 *
 * Only pull-materialization-owned fields are touched. wells/{well}/status.isDown
 * (authoritative well-down) and static config are preserved.
 */
import { namespacedWellStatePath } from './packetGuards';

export type ReconcileAction = 'set' | 'clear' | 'skip';

/** Pure ownership decision, evaluated inside the CAS transaction with the real
 * server-stored owner. */
export function decideDeleteReconcile(input: {
  storedOwnerId: string;
  storedOwnerUtc: string | null;
  deletedPacketId: string;
  survivingLatestId: string | null;
  survivingLatestUtc: string | null;
}): ReconcileAction {
  const deletedWasOwner = !!input.storedOwnerId && input.storedOwnerId === input.deletedPacketId;
  if (!input.survivingLatestId) {
    // Well emptied. Clear only when the projection still shows the deleted
    // packet (or nothing). A different (newer) pull now owning it → skip.
    return deletedWasOwner || !input.storedOwnerId ? 'clear' : 'skip';
  }
  if (deletedWasOwner) return 'set';
  if (input.storedOwnerId === input.survivingLatestId) return 'set'; // owner IS the survivor → refresh (historical delete)
  if (!input.storedOwnerId) return 'set'; // no owner recorded → adopt the survivor
  // A DIFFERENT pull owns the projection. Fail closed: only overwrite when it is
  // PROVABLY strictly older than the survivor. Newer, equal-timestamp (canonical
  // tie-break: existing owner wins), or unreadable timestamps → skip, never
  // regressing a concurrent newer pull.
  const ownerMs = input.storedOwnerUtc ? Date.parse(input.storedOwnerUtc) : NaN;
  const survMs = input.survivingLatestUtc ? Date.parse(input.survivingLatestUtc) : NaN;
  if (!Number.isNaN(ownerMs) && !Number.isNaN(survMs) && ownerMs < survMs) return 'set';
  return 'skip';
}

export interface PullOwnedStatus {
  wellName: string;
  config: { tanks: number; bottomLevel: number; route: string; pullBbls: number };
  current: { level: string; levelInches: number; asOf: string };
  lastPull: Record<string, unknown>;
  calculated: Record<string, unknown>;
}

/** Minimal structural RTDB surface — real admin.database() satisfies it; tests
 * pass the emulator database. */
export interface ReconcileDb {
  ref(path: string): {
    transaction(update: (node: unknown) => unknown): Promise<{ committed: boolean }>;
    update(value: Record<string, unknown>): Promise<unknown>;
  };
}

export async function reconcileWellAfterDelete(deps: {
  db: ReconcileDb;
  companyId: string;
  wellKey: string;
  wellName: string;
  deletedPacketId: string;
  survivingLatestId: string | null;
  survivingLatestUtc: string | null;
  /** Pull-owned status rebuilt from the surviving latest; null when clearing. */
  pullOwned: PullOwnedStatus | null;
  now?: () => string;
  /** Test hook: fired after the companyWells CAS commits and BEFORE the
   *  wells/status transaction, to force the delete/new-pull interleaving. */
  afterCasHook?: () => Promise<void>;
}): Promise<{ action: ReconcileAction; statusAction: ReconcileAction }> {
  const now = deps.now || (() => new Date().toISOString());
  const path = namespacedWellStatePath(deps.companyId, deps.wellKey);
  // Boxed so the outcome survives the transaction-callback boundary (its final
  // value reflects the authoritative server-value run).
  const box: { action: ReconcileAction } = { action: 'skip' };

  await deps.db.ref(path).transaction((node) => {
    // Admin SDK optimistic null-first: keep the transaction alive so it re-runs
    // against the authoritative server node (the P0 pattern) instead of aborting.
    if (node == null || typeof node !== 'object') return {};
    const n = node as Record<string, unknown>;
    const hw = n.pullHighWater && typeof n.pullHighWater === 'object'
      ? (n.pullHighWater as Record<string, unknown>)
      : null;
    const action = decideDeleteReconcile({
      storedOwnerId: hw ? String(hw.packetId || '') : '',
      storedOwnerUtc: hw ? (typeof hw.dateTimeUTC === 'string' ? hw.dateTimeUTC : null) : null,
      deletedPacketId: deps.deletedPacketId,
      survivingLatestId: deps.survivingLatestId,
      survivingLatestUtc: deps.survivingLatestUtc,
    });
    box.action = action;
    if (action === 'skip') return undefined; // abort — a newer owner wins
    if (action === 'clear') {
      const next = { ...n };
      delete next.pullHighWater;
      delete next.materializedPacketId;
      delete next.current;
      return next;
    }
    // set — preserve authoritative isDown carried on the materialized current.
    const prevCurrent = n.current && typeof n.current === 'object' ? (n.current as Record<string, unknown>) : {};
    const preservedIsDown = typeof prevCurrent.isDown === 'boolean' ? prevCurrent.isDown : false;
    const current = { ...(deps.pullOwned as unknown as Record<string, unknown>), isDown: preservedIsDown };
    return {
      ...n,
      companyId: deps.companyId,
      wellKey: deps.wellKey,
      pullHighWater: {
        dateTimeUTC: deps.survivingLatestUtc,
        packetId: deps.survivingLatestId,
        companyId: deps.companyId,
        wellKey: deps.wellKey,
      },
      materializedPacketId: deps.survivingLatestId,
      current,
    };
  });

  // Forced-interleaving hook (tests only): a newer natural pull may materialize
  // BOTH projections here, after the companyWells CAS and before the status write.
  if (deps.afterCasHook) await deps.afterCasHook();

  // wells/{well}/status — INDEPENDENT ownership-aware transaction. The companyWells
  // CAS cannot protect a later write to this separate node, so re-evaluate
  // ownership against the status's OWN current owner (lastPull.packetId/time)
  // inside the transaction and abort if a newer pull now owns it. Only pull-owned
  // fields are touched; isDown (authoritative well-down), static config, and every
  // other field are preserved.
  const statusBox: { action: ReconcileAction } = { action: 'skip' };
  await deps.db.ref(`wells/${deps.wellName}/status`).transaction((node) => {
    // Optimistic null-first: keep the transaction alive so it re-runs against the
    // authoritative server value (wells/status exists after any pull).
    if (node == null) return {};
    if (typeof node !== 'object') return node;
    const n = node as Record<string, unknown>;
    const lp = n.lastPull && typeof n.lastPull === 'object' ? (n.lastPull as Record<string, unknown>) : null;
    const action = decideDeleteReconcile({
      storedOwnerId: lp ? String(lp.packetId || '') : '',
      storedOwnerUtc: lp ? (typeof lp.dateTimeUTC === 'string' ? lp.dateTimeUTC : null) : null,
      deletedPacketId: deps.deletedPacketId,
      survivingLatestId: deps.survivingLatestId,
      survivingLatestUtc: deps.survivingLatestUtc,
    });
    statusBox.action = action;
    if (action === 'skip') return undefined; // a newer pull owns status → do not regress
    if (action === 'clear') {
      const next = { ...n };
      delete next.current;
      delete next.lastPull;
      delete next.calculated;
      next.updatedAt = now();
      return next; // isDown + config + others preserved
    }
    if (!deps.pullOwned) return undefined; // set requires the rebuilt fields
    return {
      ...n,
      current: deps.pullOwned.current,
      lastPull: deps.pullOwned.lastPull,
      calculated: deps.pullOwned.calculated,
      updatedAt: now(),
    };
  });

  return { action: box.action, statusAction: statusBox.action };
}
