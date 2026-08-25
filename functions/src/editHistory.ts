/**
 * Canonical edit / correction trail for processed pulls.
 *
 * Storage:
 *   packets/editHistory/{packetId}/{eventId}  — immutable applied events
 * Summary on processed packet:
 *   editedAt, editedBy, editCount, originalSubmittedAt (frozen once)
 *
 * Badge (shared conceptual predicate — typed helpers below):
 *   has edit history / editCount>0 OR editedAt OR legacy isEdit/requestType==='edit'
 *
 * Server derives previous values from stored packet; client "before" is never trusted.
 */

export const EDIT_SOURCES = ['wbm', 'dashboard', 'legacy', 'unknown'] as const;
export type EditSource = (typeof EDIT_SOURCES)[number];

export const EDIT_RESOLUTION_PATHS = [
  'direct',
  'invoiceDocId_fallback',
  'queued_pull_merge',
] as const;
export type EditResolutionPath = (typeof EDIT_RESOLUTION_PATHS)[number];

/** Material fields that may appear in a field-level correction diff. */
export const EDITABLE_FIELDS = [
  'tankTopInches',
  'tankLevelFeet',
  'bblsTaken',
  'dateTimeUTC',
  'dateTime',
  'wellDown',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface FieldChange {
  field: EditableField;
  previous: string | number | boolean | null;
  next: string | number | boolean | null;
}

/**
 * Product boundary (authoritative):
 * - WB-T ticket editing has its own 24h limit (WB-T app only — not this CF).
 * - WB-M route/flow corrections have NO age deadline.
 * - Dashboard corrections of pull packets have NO age deadline via this path.
 * Submission timestamps are audit data only and must never gate WB-M applies.
 */
export const WBM_HAS_EDIT_DEADLINE = false as const;
export const WBT_TICKET_EDIT_WINDOW_HOURS = 24 as const; // documentation pin only

export function normalizeEditSource(raw: unknown): EditSource {
  if (raw === 'wbm' || raw === 'dashboard' || raw === 'legacy' || raw === 'unknown') {
    return raw;
  }
  // Do NOT map missing to dashboard — that mislabeled WB-M edits historically.
  if (raw === undefined || raw === null || raw === '') return 'unknown';
  return 'unknown';
}

/** Original packet origin (not the correction source). */
export function normalizeOriginAppContext(raw: unknown): 'wbt' | 'wbm' | 'unknown' {
  if (raw === 'wbt' || raw === 'wbm') return raw;
  return 'unknown';
}

/**
 * Stable edit-event id. Prefer client-supplied idempotency key; else the
 * incoming RTDB key (edit_…). Retries of the same request reuse the same id.
 */
export function resolveEditEventId(args: {
  incomingPacketId: string;
  clientEventId?: unknown;
}): string {
  const client =
    typeof args.clientEventId === 'string' ? args.clientEventId.trim() : '';
  if (client.length >= 8) {
    return client.replace(/[.#$\[\]/]/g, '_').slice(0, 120);
  }
  return String(args.incomingPacketId).replace(/[.#$\[\]/]/g, '_').slice(0, 120);
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function topInches(p: Record<string, unknown>): number | null {
  const ti = num(p.tankTopInches);
  if (ti !== null) return Math.round(ti);
  const feet = num(p.tankLevelFeet);
  if (feet !== null) return Math.round(feet * 12);
  return null;
}

/**
 * Derive field-level before→after from stored packet vs applied next values.
 * Only include fields that actually change.
 */
export function buildFieldDiff(
  previous: Record<string, unknown>,
  next: {
    tankTopInches?: number;
    tankLevelFeet?: number;
    bblsTaken?: number;
    dateTimeUTC?: string;
    dateTime?: string;
    wellDown?: boolean;
  },
): FieldChange[] {
  const changes: FieldChange[] = [];

  if (next.tankTopInches !== undefined || next.tankLevelFeet !== undefined) {
    const prevTop = topInches(previous);
    const nextTop =
      next.tankTopInches !== undefined
        ? Math.round(Number(next.tankTopInches))
        : next.tankLevelFeet !== undefined
          ? Math.round(Number(next.tankLevelFeet) * 12)
          : null;
    if (prevTop !== nextTop) {
      changes.push({
        field: 'tankTopInches',
        previous: prevTop,
        next: nextTop,
      });
      const prevFeet = num(previous.tankLevelFeet);
      const nextFeet =
        next.tankLevelFeet !== undefined
          ? Number(next.tankLevelFeet)
          : nextTop !== null
            ? nextTop / 12
            : null;
      if (prevFeet !== nextFeet) {
        changes.push({
          field: 'tankLevelFeet',
          previous: prevFeet,
          next: nextFeet,
        });
      }
    }
  }

  if (next.bblsTaken !== undefined) {
    const prevB = num(previous.bblsTaken);
    const nextB = num(next.bblsTaken);
    if (prevB !== nextB) {
      changes.push({ field: 'bblsTaken', previous: prevB, next: nextB });
    }
  }

  if (next.dateTimeUTC !== undefined && next.dateTimeUTC !== '') {
    const prevU = previous.dateTimeUTC == null ? null : String(previous.dateTimeUTC);
    const nextU = String(next.dateTimeUTC);
    if (prevU !== nextU) {
      changes.push({ field: 'dateTimeUTC', previous: prevU, next: nextU });
    }
  }

  if (next.dateTime !== undefined && next.dateTime !== '') {
    const prevD = previous.dateTime == null ? null : String(previous.dateTime);
    const nextD = String(next.dateTime);
    if (prevD !== nextD) {
      changes.push({ field: 'dateTime', previous: prevD, next: nextD });
    }
  }

  if (next.wellDown !== undefined) {
    const prevW = previous.wellDown === true || previous.wellDown === 'true';
    const nextW = next.wellDown === true;
    if (prevW !== nextW) {
      changes.push({ field: 'wellDown', previous: prevW, next: nextW });
    }
  }

  return changes;
}

/**
 * Original submission time for the 24h window and paper trail.
 * Prefer frozen originalSubmittedAt; else first processed dateTimeUTC / processedAt.
 */
export function resolveOriginalSubmissionAt(
  processed: Record<string, unknown>,
): string | null {
  if (typeof processed.originalSubmittedAt === 'string' && processed.originalSubmittedAt) {
    return processed.originalSubmittedAt;
  }
  if (typeof processed.dateTimeUTC === 'string' && processed.dateTimeUTC) {
    return processed.dateTimeUTC;
  }
  if (typeof processed.processedAt === 'string' && processed.processedAt) {
    return processed.processedAt;
  }
  return null;
}

/**
 * WB-M / Dashboard pull corrections are never age-gated here.
 * Returns original submission timestamp for audit only.
 */
export function resolveEditAuditContext(processed: Record<string, unknown>): {
  allowed: true;
  originalSubmissionAt: string | null;
  originAppContext: 'wbt' | 'wbm' | 'unknown';
} {
  return {
    allowed: true,
    originalSubmissionAt: resolveOriginalSubmissionAt(processed),
    originAppContext: normalizeOriginAppContext(processed.originAppContext),
  };
}

/** Canonical + legacy badge predicate for a processed-row-shaped object. */
export function packetShowsEditBadge(p: Record<string, unknown> | null | undefined): boolean {
  if (!p) return false;
  if (typeof p.editCount === 'number' && p.editCount > 0) return true;
  if (typeof p.editedAt === 'string' && p.editedAt.length > 0) return true;
  if (p.isEdit === true) return true;
  if (p.requestType === 'edit') return true;
  // wasEdited marks the superseded original in the legacy dual-row model —
  // readers that skip wasEdited rows should not badge them as current edits.
  return false;
}

export function nextEditCount(processed: Record<string, unknown>): number {
  const n = Number(processed.editCount);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) + 1 : 1;
}

export interface BuildAppliedEventArgs {
  eventId: string;
  packetId: string;
  sequence: number;
  editedAt: string;
  /** Correction source (who applied this edit). */
  source: EditSource;
  /** Original pull origin app when known (wbt/wbm). */
  originAppContext?: 'wbt' | 'wbm' | 'unknown' | null;
  actorDriverId?: string | null;
  actorDriverName?: string | null;
  clientAppVersion?: string | null;
  fields: FieldChange[];
  originalSubmissionAt: string | null;
  resolutionPath: EditResolutionPath;
  editRequestId: string;
}

export interface EditHistoryEvent {
  eventId: string;
  packetId: string;
  sequence: number;
  editedAt: string;
  source: EditSource;
  originAppContext?: 'wbt' | 'wbm' | 'unknown' | null;
  actorDriverId?: string | null;
  actorDriverName?: string | null;
  clientAppVersion?: string | null;
  fields: FieldChange[];
  originalSubmissionAt: string | null;
  outcome: 'applied';
  resolutionPath: EditResolutionPath;
  editRequestId: string;
}

export function buildAppliedEditEvent(args: BuildAppliedEventArgs): EditHistoryEvent {
  return {
    eventId: args.eventId,
    packetId: args.packetId,
    sequence: args.sequence,
    editedAt: args.editedAt,
    source: args.source,
    originAppContext: args.originAppContext ?? null,
    actorDriverId: args.actorDriverId ?? null,
    actorDriverName: args.actorDriverName ?? null,
    clientAppVersion: args.clientAppVersion ?? null,
    fields: args.fields,
    originalSubmissionAt: args.originalSubmissionAt,
    outcome: 'applied',
    resolutionPath: args.resolutionPath,
    editRequestId: args.editRequestId,
  };
}

/** Multi-path RTDB updates for one applied edit (caller merges with value updates). */
export function editHistoryWritePaths(
  packetId: string,
  event: EditHistoryEvent,
): Record<string, unknown> {
  return {
    [`packets/editHistory/${packetId}/${event.eventId}`]: event,
  };
}

export type EditAppliedReceipt = {
  editEventId: string;
  originalPacketId: string;
  payloadDigest: string | null;
  appliedAt: string;
  status: 'accepted';
};

export function buildAppliedEditReceipt(args: {
  editEventId: string;
  originalPacketId: string;
  payloadDigest: unknown;
  appliedAt: string;
}): EditAppliedReceipt {
  return {
    editEventId: args.editEventId,
    originalPacketId: args.originalPacketId,
    payloadDigest: typeof args.payloadDigest === 'string' && args.payloadDigest
      ? args.payloadDigest
      : null,
    appliedAt: args.appliedAt,
    status: 'accepted',
  };
}

export function editReceiptWritePaths(
  editEventId: string,
  receipt: EditAppliedReceipt,
): Record<string, unknown> {
  return {
    [`packets/editReceipts/${editEventId}`]: receipt,
  };
}

/** Summary fields stamped on the processed packet for badge + counters. */
export function editSummaryFields(args: {
  editedAt: string;
  source: EditSource;
  editCount: number;
  originalSubmissionAt: string | null;
  freezeOriginal: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    editedAt: args.editedAt,
    editedBy: args.source,
    editCount: args.editCount,
  };
  if (args.freezeOriginal && args.originalSubmissionAt) {
    out.originalSubmittedAt = args.originalSubmissionAt;
  }
  return out;
}
