/**
 * Owner-scoped reconciliation of packets/outgoing after a governed delete.
 *
 * The legacy delete rebuilt outgoing with delete-all-then-write, which could
 * remove or be displaced by a concurrent newer pull's row. This replaces it:
 *   - remove ONLY the outgoing row(s) owned by the deleted packet (never a row
 *     owned by a different/newer pull);
 *   - write the survivor's row ONLY when no remaining row is current-or-newer
 *     (fail closed on newer/equal/unreadable owners);
 *   - key the survivor row DETERMINISTICALLY by the survivor's dateTimeUTC so it
 *     is idempotent on retry AND always sorts below a concurrent newer pull's
 *     (write-time-keyed) row — the existing Dashboard reader + processIncomingPull
 *     guard both select per well by max response key, so the newer pull wins.
 *
 * No processIncomingPull change and no reader change: outgoing rows already carry
 * lastPullPacketId + lastPullDateTimeUTC, which is sufficient ownership metadata.
 */

/** The write-time (or, for the delete survivor, backdated) response key. */
export function outgoingResponseKey(dateTimeUTC: string, cleanName: string): string {
  const iso = new Date(dateTimeUTC).toISOString();
  return `response_${iso.replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;
}

/** Model of the Dashboard/guard per-well selection: the row with the max key. */
export function selectByMaxKey<T extends { key: string }>(rows: T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.key && (best === null || r.key > best.key)) best = r;
  }
  return best;
}

/**
 * Whether to (re)write the survivor's outgoing row. Fail closed: any remaining
 * (non-deleted) row that is current-or-newer than the survivor, or whose
 * ownership cannot be read, means something else owns the projection → do not
 * write. Canonical tie-break: an equal-timestamp different owner keeps it.
 */
export function decideOutgoingWrite(input: {
  remaining: Array<{ ownerId: string; ownerUtc: string | null }>;
  survivorId: string | null;
  survivorUtc: string | null;
}): boolean {
  if (!input.survivorId || !input.survivorUtc) return false;
  const sMs = Date.parse(input.survivorUtc);
  if (Number.isNaN(sMs)) return false;
  for (const r of input.remaining) {
    if (!r.ownerId) continue; // ownerless legacy row — does not hold ownership
    const rMs = r.ownerUtc ? Date.parse(r.ownerUtc) : NaN;
    if (Number.isNaN(rMs)) return false;     // unreadable owner → fail closed
    if (rMs >= sMs) return false;            // current-or-newer owner present
  }
  return true;
}

/** Structural RTDB surface — real admin.database() satisfies it; tests inject a fake. */
export interface OutgoingDb {
  ref(path: string): {
    orderByChild(key: string): {
      equalTo(value: string): {
        once(eventType: string): Promise<{ forEach(cb: (c: { key: string | null; val(): unknown }) => void): void }>;
      };
    };
    remove(): Promise<unknown>;
    set(value: unknown): Promise<unknown>;
  };
}

export async function applyOutgoingAfterDelete(deps: {
  db: OutgoingDb;
  wellName: string;
  cleanName: string;
  deletedPacketId: string;
  survivorRow: Record<string, unknown> | null;
  survivorId: string | null;
  survivorUtc: string | null;
  /** Test hook: fired after owner-scoped removal, before the survivor write. */
  afterRemovalHook?: () => Promise<void>;
}): Promise<{ removed: number; wroteSurvivor: boolean; survivorKey: string | null }> {
  const snap = await deps.db
    .ref('packets/outgoing')
    .orderByChild('wellName')
    .equalTo(deps.wellName)
    .once('value');
  const rows: Array<{ key: string; ownerId: string; ownerUtc: string | null }> = [];
  snap.forEach((c) => {
    const v = (c.val() || {}) as Record<string, unknown>;
    rows.push({
      key: String(c.key || ''),
      ownerId: typeof v.lastPullPacketId === 'string' ? v.lastPullPacketId : '',
      ownerUtc: typeof v.lastPullDateTimeUTC === 'string' ? v.lastPullDateTimeUTC : null,
    });
  });

  // Owner-scoped removal: ONLY rows owned by the deleted packet.
  const toRemove = rows.filter((r) => r.ownerId === deps.deletedPacketId && r.key);
  const remaining = rows.filter((r) => r.ownerId !== deps.deletedPacketId);
  await Promise.all(toRemove.map((r) => deps.db.ref(`packets/outgoing/${r.key}`).remove()));

  if (deps.afterRemovalHook) await deps.afterRemovalHook();

  let wroteSurvivor = false;
  let survivorKey: string | null = null;
  if (decideOutgoingWrite({ remaining, survivorId: deps.survivorId, survivorUtc: deps.survivorUtc })
      && deps.survivorRow && deps.survivorUtc) {
    survivorKey = outgoingResponseKey(deps.survivorUtc, deps.cleanName);
    await deps.db.ref(`packets/outgoing/${survivorKey}`).set(deps.survivorRow);
    wroteSurvivor = true;
  }
  return { removed: toRemove.length, wroteSurvivor, survivorKey };
}
