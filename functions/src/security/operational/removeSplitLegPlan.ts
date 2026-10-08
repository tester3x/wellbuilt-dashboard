/** Pure decision for removing one future split leg. */
export interface SplitRemovalLeg {
  id: string;
  splitSequence: number;
  status: string;
  wellName?: string;
  ndicWellName?: string;
}

const terminal = new Set(['completed', 'cancelled', 'declined', 'dismissed']);
const started = new Set(['accepted', 'in_progress', 'paused']);

export function planSplitLegRemoval(legs: SplitRemovalLeg[], targetId: string):
  | { ok: false; reason: string }
  | { ok: true; order: Array<{ id: string; splitSequence: number }>; rerouteAnchor?: { id: string; destination: string }; lastStopAnchorId?: string } {
  const live = legs.filter(leg => !terminal.has(leg.status))
    .sort((a, b) => a.splitSequence - b.splitSequence);
  if (live.length < 2 || live.some(leg => !Number.isInteger(leg.splitSequence) || leg.splitSequence < 1)) {
    return { ok: false, reason: 'invalid_split_family' };
  }
  if (new Set(live.map(leg => leg.splitSequence)).size !== live.length) {
    return { ok: false, reason: 'duplicate_split_sequence' };
  }
  const targetIndex = live.findIndex(leg => leg.id === targetId);
  if (targetIndex < 0) return { ok: false, reason: 'leg_not_live' };
  if (targetIndex === 0) return { ok: false, reason: 'cannot_remove_anchor' };
  if (started.has(live[targetIndex].status)) return { ok: false, reason: 'cannot_remove_started_leg' };
  if (live[targetIndex].status !== 'pending') return { ok: false, reason: 'leg_not_pending' };

  const survivors = live.filter(leg => leg.id !== targetId);
  const base = live[0].splitSequence;
  const order = survivors.map((leg, index) => ({ id: leg.id, splitSequence: base + index }));

  if (targetIndex === 1 && survivors.length === 1) {
    return { ok: true, order, lastStopAnchorId: survivors[0].id };
  }

  // B is the first on-site stop. Removing it skips the destination that A
  // currently travels to, so A must travel to the new first on-site stop.
  if (targetIndex === 1 && survivors.length > 1) {
    const anchor = survivors[0];
    if (anchor.status !== 'pending') return { ok: false, reason: 'anchor_already_started' };
    const next = survivors[1];
    const destination = (next.wellName || next.ndicWellName || '').trim();
    if (!destination) return { ok: false, reason: 'next_destination_missing' };
    return { ok: true, order, rerouteAnchor: { id: anchor.id, destination } };
  }
  return { ok: true, order };
}
