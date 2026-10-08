export function planSplitFamilyDecline(legs: Array<{ id: string; status: string; splitSequence: number }> ):
  | { ok: true; declineIds: string[] }
  | { ok: false; reason: string } {
  if (!legs.length) return { ok: false, reason: 'split_family_not_found' };
  if (legs.some(leg => leg.status === 'completed')) return { ok: false, reason: 'family_has_completed_leg' };
  const live = legs.filter(leg => !['cancelled', 'declined', 'dismissed'].includes(leg.status));
  if (!live.length) return { ok: true, declineIds: [] };
  const anchor = live.reduce((a, b) => a.splitSequence < b.splitSequence ? a : b);
  if (anchor.splitSequence !== 1 || anchor.status !== 'pending') {
    return { ok: false, reason: 'anchor_not_pending' };
  }
  if (live.some(leg => leg.status !== 'pending')) return { ok: false, reason: 'family_already_started' };
  return { ok: true, declineIds: live.map(leg => leg.id) };
}
