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
 * Canonical editable-value snapshot used for chronological materialization.
 * `tankTopInches` is the canonical level (feet are derived at write time),
 * and `dateTime` is the display companion of `dateTimeUTC`. Only the keys a
 * correction actually asserts are present on a correction's snapshot; a frozen
 * baseline snapshot carries every field of the original pull.
 */
export interface EditableSnapshot {
  tankTopInches?: number | null;
  bblsTaken?: number | null;
  dateTimeUTC?: string | null;
  dateTime?: string | null;
  wellDown?: boolean | null;
}

/** Logical materialization fields (dateTime rides with dateTimeUTC). */
export const MATERIALIZED_FIELDS = [
  'tankTopInches',
  'bblsTaken',
  'dateTimeUTC',
  'dateTime',
  'wellDown',
] as const;
export type MaterializedField = (typeof MATERIALIZED_FIELDS)[number];

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
  /**
   * Immutable event-time captured once on the client at correction submit
   * (offset-aware ISO). Ordering key for chronological materialization. Never
   * network-arrival, retry, or server time; never inferred from the pull's
   * business date/time (dateTimeUTC). Null for legacy (pre-v2) events, which
   * are never re-materialized and keep their existing trail — a missing
   * timestamp is preserved as null, never back-filled with "now".
   */
  correctionCreatedAtUTC?: string | null;
  /** Server wall-clock when this correction was received/applied (audit only). */
  serverReceivedAtUTC?: string | null;
  /** The editable fields THIS correction actually asserts (present-only). */
  correctionValues?: EditableSnapshot;
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
  correctionCreatedAtUTC: string | null;
  serverReceivedAtUTC: string | null;
  correctionValues: EditableSnapshot;
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
    correctionCreatedAtUTC: args.correctionCreatedAtUTC ?? null,
    serverReceivedAtUTC: args.serverReceivedAtUTC ?? args.editedAt,
    correctionValues: args.correctionValues ?? {},
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

/**
 * How a recorded correction relates to the current materialized state:
 * - recorded_current    every field it asserts is authoritative for current state
 * - recorded_partial    some asserted fields authoritative, others superseded
 * - recorded_superseded recorded + durable, but no asserted field affects current
 * - recorded_no_change  recorded, asserted no editable field (nothing to materialize)
 */
export type EditMaterializationOutcome =
  | 'recorded_current'
  | 'recorded_partial'
  | 'recorded_superseded'
  | 'recorded_no_change';

export type EditAppliedReceipt = {
  editEventId: string;
  originalPacketId: string;
  payloadDigest: string | null;
  appliedAt: string;
  status: 'accepted';
  /** Immutable client event-time this receipt corresponds to (when known). */
  correctionCreatedAtUTC?: string | null;
  /** Server receive + apply wall-clock, recorded separately from event-time. */
  serverReceivedAtUTC?: string | null;
  serverAppliedAtUTC?: string | null;
  /** Materialization effect of this correction on the current record. */
  outcome?: EditMaterializationOutcome;
  fieldsAffectingCurrent?: MaterializedField[];
  fieldsSuperseded?: MaterializedField[];
};

export function buildAppliedEditReceipt(args: {
  editEventId: string;
  originalPacketId: string;
  payloadDigest: unknown;
  appliedAt: string;
  correctionCreatedAtUTC?: string | null;
  serverReceivedAtUTC?: string | null;
  serverAppliedAtUTC?: string | null;
  outcome?: EditMaterializationOutcome;
  fieldsAffectingCurrent?: MaterializedField[];
  fieldsSuperseded?: MaterializedField[];
}): EditAppliedReceipt {
  const receipt: EditAppliedReceipt = {
    editEventId: args.editEventId,
    originalPacketId: args.originalPacketId,
    payloadDigest: typeof args.payloadDigest === 'string' && args.payloadDigest
      ? args.payloadDigest
      : null,
    appliedAt: args.appliedAt,
    status: 'accepted',
  };
  if (args.correctionCreatedAtUTC !== undefined) {
    receipt.correctionCreatedAtUTC = args.correctionCreatedAtUTC;
  }
  if (args.serverReceivedAtUTC !== undefined) receipt.serverReceivedAtUTC = args.serverReceivedAtUTC;
  if (args.serverAppliedAtUTC !== undefined) receipt.serverAppliedAtUTC = args.serverAppliedAtUTC;
  if (args.outcome !== undefined) receipt.outcome = args.outcome;
  if (args.fieldsAffectingCurrent !== undefined) receipt.fieldsAffectingCurrent = args.fieldsAffectingCurrent;
  if (args.fieldsSuperseded !== undefined) receipt.fieldsSuperseded = args.fieldsSuperseded;
  return receipt;
}

export function editReceiptWritePaths(
  editEventId: string,
  receipt: EditAppliedReceipt,
): Record<string, unknown> {
  return {
    [`packets/editReceipts/${editEventId}`]: receipt,
  };
}

/** Strip seconds from a display time ("4/9/2026, 2:40:00 PM" → "4/9/2026, 2:40 PM"). */
export function normalizeDisplayDateTime(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/:(\d{2})\s*(AM|PM)/i, ' $2');
}

/**
 * The editable fields a single incoming correction actually asserts, present
 * only. Level is canonicalized to tankTopInches (dashboard inches or WB-M
 * feet×12). Empty/absent operational time is NOT an assertion — it preserves
 * the prior value in replay (never substitutes "now").
 */
export function extractAssertedEditableValues(raw: Record<string, unknown>): EditableSnapshot {
  const out: EditableSnapshot = {};
  if (raw.tankTopInches !== undefined && raw.tankTopInches !== null && raw.tankTopInches !== '') {
    const n = Number(raw.tankTopInches);
    if (Number.isFinite(n)) out.tankTopInches = n;
  } else if (raw.tankLevelFeet !== undefined && raw.tankLevelFeet !== null && raw.tankLevelFeet !== '') {
    const n = Number(raw.tankLevelFeet);
    if (Number.isFinite(n)) out.tankTopInches = n * 12;
  }
  if (raw.bblsTaken !== undefined && raw.bblsTaken !== null && raw.bblsTaken !== '') {
    const n = Number(raw.bblsTaken);
    if (Number.isFinite(n)) out.bblsTaken = n;
  }
  if (typeof raw.dateTimeUTC === 'string' && raw.dateTimeUTC.trim() !== '') {
    out.dateTimeUTC = raw.dateTimeUTC.trim();
  }
  if (typeof raw.dateTime === 'string' && raw.dateTime.trim() !== '') {
    out.dateTime = normalizeDisplayDateTime(raw.dateTime);
  }
  if (raw.wellDown !== undefined) {
    out.wellDown = raw.wellDown === true || raw.wellDown === 'true';
  }
  return out;
}

/**
 * The fields a correction actually CHANGES, relative to the frozen baseline.
 *
 * The governed wire always carries the full snapshot (tankLevelFeet + bblsTaken
 * are always present), so field PRESENCE cannot express intent. A correction is
 * treated as touching a field only when its value differs from the frozen
 * baseline — this is what lets a level-only correction and a bbls-only
 * correction each own their own field regardless of arrival order, while an
 * echoed-unchanged field never supersedes a prior real change.
 *
 * Known boundary: a correction that deliberately restores a field to its exact
 * original (baseline) value is indistinguishable from an unchanged echo and is
 * therefore not treated as a change. This is inherent to a full-snapshot wire.
 */
export function assertedChangesAgainstBaseline(
  raw: Record<string, unknown>,
  baseline: EditableSnapshot,
): EditableSnapshot {
  const sent = extractAssertedEditableValues(raw);
  const out: EditableSnapshot = {};
  if (sent.tankTopInches !== undefined && sent.tankTopInches !== null) {
    const b = baseline.tankTopInches;
    if (b === undefined || b === null
      || Math.round(Number(sent.tankTopInches)) !== Math.round(Number(b))) {
      out.tankTopInches = sent.tankTopInches;
    }
  }
  if (sent.bblsTaken !== undefined && sent.bblsTaken !== null) {
    const b = baseline.bblsTaken;
    if (b === undefined || b === null || Number(sent.bblsTaken) !== Number(b)) {
      out.bblsTaken = sent.bblsTaken;
    }
  }
  if (sent.dateTimeUTC !== undefined) {
    if (String(sent.dateTimeUTC) !== String(baseline.dateTimeUTC ?? '')) {
      out.dateTimeUTC = sent.dateTimeUTC;
    }
  }
  if (sent.dateTime !== undefined) {
    if (String(sent.dateTime) !== String(baseline.dateTime ?? '')) {
      out.dateTime = sent.dateTime;
    }
  }
  if (sent.wellDown !== undefined) {
    if ((sent.wellDown === true) !== (baseline.wellDown === true)) {
      out.wellDown = sent.wellDown;
    }
  }
  return out;
}

/**
 * Frozen editable-field snapshot of the original pull BEFORE any correction.
 * Captured once (on the first applied edit) and never rewritten — the anchor
 * for deterministic chronological replay.
 */
export function buildEditBaseline(p: Record<string, unknown>): EditableSnapshot {
  const ti = num(p.tankTopInches);
  const feet = num(p.tankLevelFeet);
  const top = ti !== null ? ti : feet !== null ? feet * 12 : null;
  return {
    tankTopInches: top,
    bblsTaken: num(p.bblsTaken),
    dateTimeUTC: typeof p.dateTimeUTC === 'string' && p.dateTimeUTC ? p.dateTimeUTC : null,
    dateTime: typeof p.dateTime === 'string' && p.dateTime ? p.dateTime : null,
    wellDown: p.wellDown === true || p.wellDown === 'true',
  };
}

/** Minimal event shape the materializer needs (subset of EditHistoryEvent). */
export interface MaterializableEvent {
  eventId: string;
  correctionCreatedAtUTC: string;
  correctionValues: EditableSnapshot;
}

/**
 * Deterministic total order over corrections: ascending event-time
 * (correctionCreatedAtUTC), then ascending eventId as a stable tie-break so
 * equal timestamps never depend on arrival / trigger / array order.
 * Unparseable timestamps sort last (deterministically) but are rejected before
 * they can be recorded, so this is a guard, not a live path.
 */
export function compareEditEvents(a: MaterializableEvent, b: MaterializableEvent): number {
  const ta = Date.parse(a.correctionCreatedAtUTC);
  const tb = Date.parse(b.correctionCreatedAtUTC);
  const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
  const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
  if (va !== vb) return va - vb;
  if (a.eventId < b.eventId) return -1;
  if (a.eventId > b.eventId) return 1;
  return 0;
}

export function sortEditEventsChronologically<T extends MaterializableEvent>(events: T[]): T[] {
  return [...events].sort(compareEditEvents);
}

export interface MaterializationResult {
  /** Current editable values after chronological replay from baseline. */
  fields: EditableSnapshot;
  /** field → eventId of the newest correction that set it (baseline has none). */
  authority: Partial<Record<MaterializedField, string>>;
  /** Applied order (chronological), for the audit trail. */
  orderedEventIds: string[];
}

/**
 * Pure, order-independent, idempotent materialization. The current record is a
 * deterministic function of {frozen baseline, set of accepted corrections}: sort
 * by event-time, replay applying ONLY the fields each correction asserts, and
 * the newest correction touching a field is authoritative for it. Because the
 * result depends only on the SET of events (not their insertion/arrival order),
 * concurrent triggers, retries, and re-applies all converge to the same value.
 */
export function materializeEditableFields(
  baseline: EditableSnapshot,
  events: MaterializableEvent[],
): MaterializationResult {
  const sorted = sortEditEventsChronologically(events);
  const fields: EditableSnapshot = { ...baseline };
  const authority: Partial<Record<MaterializedField, string>> = {};
  for (const ev of sorted) {
    const cv = ev.correctionValues || {};
    for (const f of MATERIALIZED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(cv, f) && cv[f] !== undefined) {
        (fields as Record<string, unknown>)[f] = (cv as Record<string, unknown>)[f];
        authority[f] = ev.eventId;
      }
    }
  }
  return { fields, authority, orderedEventIds: sorted.map((e) => e.eventId) };
}

/**
 * Classify how one recorded correction relates to the materialized current
 * state, for the receipt: which asserted fields it still owns vs which were
 * superseded by a newer correction.
 */
export function classifyEditOutcome(
  eventId: string,
  correctionValues: EditableSnapshot,
  authority: Partial<Record<MaterializedField, string>>,
): {
  outcome: EditMaterializationOutcome;
  fieldsAffectingCurrent: MaterializedField[];
  fieldsSuperseded: MaterializedField[];
} {
  const asserted = MATERIALIZED_FIELDS.filter(
    (f) => Object.prototype.hasOwnProperty.call(correctionValues, f)
      && (correctionValues as Record<string, unknown>)[f] !== undefined,
  );
  if (asserted.length === 0) {
    return { outcome: 'recorded_no_change', fieldsAffectingCurrent: [], fieldsSuperseded: [] };
  }
  const fieldsAffectingCurrent = asserted.filter((f) => authority[f] === eventId);
  const fieldsSuperseded = asserted.filter((f) => authority[f] !== eventId);
  let outcome: EditMaterializationOutcome;
  if (fieldsAffectingCurrent.length === 0) outcome = 'recorded_superseded';
  else if (fieldsSuperseded.length === 0) outcome = 'recorded_current';
  else outcome = 'recorded_partial';
  return { outcome, fieldsAffectingCurrent, fieldsSuperseded };
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
