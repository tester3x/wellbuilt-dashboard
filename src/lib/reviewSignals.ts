// reviewSignals.ts — Dashboard presentation of the chronological pipeline's
// review information (Phase 8, packet 2026-08-29).
//
// Review tags are INFORMATIONAL/ACTIONABLE review surfaces, never rejection
// gates: a flagged pull is a fully accepted pull. Only an explicit `true`
// counts — production packets that predate the pipeline omit the fields
// entirely and render unchanged. Matching-value packets WITHOUT lineage are
// "Potential Duplicate" (both survive) — never labeled proven duplicates.
// Correction conflicts (shared lineage, different material) surface through
// the edit trail (editCount/editedAt) plus Needs Review; both rows survive.

export interface ReviewSignals {
  lateEntry: boolean;
  anomaly: boolean;
  potentialDuplicate: boolean;
  needsReview: boolean;
}

export function reviewSignalsFromPacket(p: Record<string, unknown> | null | undefined): ReviewSignals {
  return {
    lateEntry: (p?.lateEntry as unknown) === true,
    anomaly: (p?.anomaly as unknown) === true,
    potentialDuplicate: (p?.potentialDuplicate as unknown) === true,
    needsReview: (p?.needsReview as unknown) === true,
  };
}

export function hasReviewSignals(s: Partial<ReviewSignals> | null | undefined): boolean {
  return !!(s && (s.lateEntry || s.anomaly || s.potentialDuplicate || s.needsReview));
}

/** Chip metadata, in display order. Colors match the muted informational
 *  treatment: review is a nudge, not an alarm. */
export const REVIEW_SIGNAL_CHIPS: Array<{ key: keyof ReviewSignals; label: string; title: string; bg: string; fg: string }> = [
  { key: 'lateEntry', label: 'Late Entry', title: 'Entered after a newer pull already existed — accepted at its event time', bg: '#e0ecf7', fg: '#22537a' },
  { key: 'anomaly', label: 'Anomaly', title: 'Flow/recovery deviates from this well’s pattern — review, not rejected', bg: '#f5ecd7', fg: '#7a5b16' },
  { key: 'potentialDuplicate', label: 'Potential Duplicate', title: 'Matches another pull’s values with no shared lineage — BOTH survive pending review', bg: '#f0e2f2', fg: '#6d3a74' },
  { key: 'needsReview', label: 'Needs Review', title: 'The pipeline asks a human to look — the pull itself is accepted', bg: '#e4e7ea', fg: '#3d454d' },
];

export function chipsForPacket(p: Record<string, unknown> | null | undefined) {
  const s = reviewSignalsFromPacket(p);
  return REVIEW_SIGNAL_CHIPS.filter((c) => s[c.key]);
}

/** A quarantined/collision row from packets/rejected, described for review.
 *  Quarantine is EVIDENCE retention — never silent deletion. */
export interface QuarantineRow {
  key: string;
  wellName: string;
  reason: string;
  readableReason: string;
  rejectedAt: string;
  packetId: string;
  /** The original identity when the quarantined item was a re-trigger/copy. */
  originalId: string | null;
  eventTimeUTC: string | null;
}

export function describeQuarantineRow(key: string, raw: Record<string, unknown> | null | undefined): QuarantineRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const packet = (raw.packet && typeof raw.packet === 'object' ? raw.packet : {}) as Record<string, unknown>;
  const wellName = typeof raw.wellName === 'string' ? raw.wellName : (typeof packet.wellName === 'string' ? packet.wellName : '');
  if (!wellName) return null;
  const idem = typeof packet.idempotencyKey === 'string' ? packet.idempotencyKey : null;
  const orig = typeof (packet as { _originalKey?: unknown })._originalKey === 'string'
    ? String((packet as { _originalKey?: unknown })._originalKey)
    : null;
  return {
    key,
    wellName,
    reason: typeof raw.reason === 'string' ? raw.reason : 'quarantined',
    readableReason: typeof raw.readableReason === 'string' ? raw.readableReason : '',
    rejectedAt: typeof raw.rejectedAt === 'string' ? raw.rejectedAt : '',
    packetId: typeof raw.packetId === 'string' ? raw.packetId : key,
    originalId: orig ?? (idem && idem !== key ? idem : null),
    eventTimeUTC: typeof packet.dateTimeUTC === 'string' ? packet.dateTimeUTC
      : (typeof raw.incomingDateTimeUTC === 'string' ? raw.incomingDateTimeUTC : null),
  };
}
