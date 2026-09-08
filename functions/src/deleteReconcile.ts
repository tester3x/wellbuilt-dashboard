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
    // Well emptied. Clear only when we owned it (or nothing owns it).
    return deletedWasOwner || !input.storedOwnerId ? 'clear' : 'skip';
  }
  if (deletedWasOwner) return 'set';
  // Owner is a different packet. Never regress a strictly-newer owner (a
  // concurrent natural pull that landed during the delete).
  const ownerMs = input.storedOwnerUtc ? Date.parse(input.storedOwnerUtc) : NaN;
  const survMs = input.survivingLatestUtc ? Date.parse(input.survivingLatestUtc) : NaN;
  if (!Number.isNaN(ownerMs) && !Number.isNaN(survMs) && ownerMs > survMs) return 'skip';
  return 'set'; // owner == survivor (historical delete) or older → refresh
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
}): Promise<{ action: ReconcileAction }> {
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

  // wells/{well}/status — only pull-owned fields. isDown (authoritative
  // well-down) and static config are deliberately preserved (never written here).
  const statusRef = deps.db.ref(`wells/${deps.wellName}/status`);
  if (box.action === 'set' && deps.pullOwned) {
    await statusRef.update({
      current: deps.pullOwned.current,
      lastPull: deps.pullOwned.lastPull,
      calculated: deps.pullOwned.calculated,
      updatedAt: now(),
    });
  } else if (box.action === 'clear') {
    await statusRef.update({
      current: null,
      lastPull: null,
      calculated: null,
      updatedAt: now(),
    });
  }

  return { action: box.action };
}
