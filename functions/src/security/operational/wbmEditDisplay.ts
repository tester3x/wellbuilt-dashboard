/**
 * ONE display model for "what an edit changed", normalized from editHistory
 * entries (current + legacy shapes) into driver-facing before→after changes.
 *
 * Server is authoritative for BEFORE values (editHistory.fields[].previous is
 * derived from the stored packet at application time; the client "before" is
 * never trusted). This module is pure + fully unit-tested; getWbmEditStatus
 * calls it and returns the result so the client renders exact before→after and
 * never a blanket "unavailable for older records".
 *
 * Rules:
 *   • Only fields that actually changed appear (partial edits show only those).
 *   • tankTopInches and tankLevelFeet both encode the top level; the display
 *     uses tankLevelFeet (feet) and drops the redundant tankTopInches.
 *   • NET before→after per field spans the whole chronological correction
 *     sequence: earliest surviving `previous` → latest `next`. Each correction
 *     is preserved as evidence (never erased) in `corrections`.
 *   • A field whose historical `previous` is genuinely unrecoverable is reported
 *     in `unavailableBeforeFields` — NEVER fabricated.
 */

export type DisplayField = 'topLevelFeet' | 'bblsTaken' | 'wellDown' | 'dateTimeUTC';

export type RawFieldChange = {
  field?: unknown;
  previous?: unknown;
  next?: unknown;
};

/** One editHistory entry (tolerant of current + legacy shapes). */
export type EditHistoryEntry = {
  editEventId?: unknown;
  eventId?: unknown;
  editRequestId?: unknown;
  editedAt?: unknown;
  serverAppliedAtUTC?: unknown;
  correctionCreatedAtUTC?: unknown;
  sequence?: unknown;
  fields?: unknown; // array of {field, previous, next}
};

export type DisplayChange = {
  field: DisplayField;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
};

export type DisplayCorrection = {
  editEventId: string | null;
  appliedAtUTC: string | null;
  correctionCreatedAtUTC: string | null;
  changes: DisplayChange[];
};

export type EditDisplayModel = {
  /** NET change per field across the whole chronological sequence. */
  changes: DisplayChange[];
  /** Every correction, chronological, preserved as evidence. */
  corrections: DisplayCorrection[];
  /** Fields that changed but whose original before-value is unrecoverable. */
  unavailableBeforeFields: DisplayField[];
  correctionCount: number;
};

/** Map an editHistory field name to the driver-facing display field (or null to drop). */
function toDisplayField(raw: unknown): DisplayField | null {
  switch (raw) {
    case 'tankLevelFeet': return 'topLevelFeet';
    case 'tankTopInches': return null; // redundant with tankLevelFeet
    case 'bblsTaken': return 'bblsTaken';
    case 'wellDown': return 'wellDown';
    case 'dateTimeUTC': return 'dateTimeUTC';
    case 'dateTime': return null; // display companion of dateTimeUTC
    default: return null;
  }
}

function scalar(v: unknown): string | number | boolean | null {
  if (v === null) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return null;
}

/** Normalize one entry's raw fields → display changes (dedup by display field). */
function entryChanges(entry: EditHistoryEntry): DisplayChange[] {
  const raw = Array.isArray(entry.fields) ? (entry.fields as RawFieldChange[]) : [];
  const out: DisplayChange[] = [];
  const seen = new Set<DisplayField>();
  // tankLevelFeet is preferred for the top level; if only tankTopInches exists,
  // synthesize feet so a legacy inches-only entry still shows a feet change.
  const hasFeet = raw.some((f) => f.field === 'tankLevelFeet');
  for (const f of raw) {
    let df = toDisplayField(f.field);
    let before = scalar(f.previous);
    let after = scalar(f.next);
    if (f.field === 'tankTopInches' && !hasFeet) {
      df = 'topLevelFeet';
      before = typeof f.previous === 'number' ? f.previous / 12 : before;
      after = typeof f.next === 'number' ? f.next / 12 : after;
    }
    if (!df || seen.has(df)) continue;
    seen.add(df);
    out.push({ field: df, before, after });
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Chronological sort key: correctionCreatedAtUTC, then sequence, stable. */
function chronoKey(e: EditHistoryEntry): [number, number] {
  const t = str(e.correctionCreatedAtUTC) || str(e.serverAppliedAtUTC) || str(e.editedAt);
  const ms = t ? Date.parse(t) : NaN;
  const seq = Number(e.sequence);
  return [Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER, Number.isFinite(seq) ? seq : 0];
}

/**
 * Build the unified display model from all editHistory entries for one original.
 * Empty/absent history ⇒ empty model (the caller decides how to present "no
 * detail" honestly — never a fabricated before-value).
 */
export function computeEditDisplay(entries: EditHistoryEntry[] | null | undefined): EditDisplayModel {
  const list = Array.isArray(entries) ? entries.slice() : [];
  list.sort((a, b) => {
    const ka = chronoKey(a), kb = chronoKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });

  const corrections: DisplayCorrection[] = list.map((e) => ({
    editEventId: str(e.editEventId) || str(e.eventId) || str(e.editRequestId),
    appliedAtUTC: str(e.serverAppliedAtUTC) || str(e.editedAt),
    correctionCreatedAtUTC: str(e.correctionCreatedAtUTC),
    changes: entryChanges(e),
  }));

  // NET per field: earliest surviving `before` → latest `after`.
  const firstBefore = new Map<DisplayField, string | number | boolean | null>();
  const lastAfter = new Map<DisplayField, string | number | boolean | null>();
  const unavailable = new Set<DisplayField>();
  for (const corr of corrections) {
    for (const ch of corr.changes) {
      if (!firstBefore.has(ch.field)) {
        firstBefore.set(ch.field, ch.before);
        if (ch.before === null || ch.before === undefined) unavailable.add(ch.field);
      }
      lastAfter.set(ch.field, ch.after);
    }
  }
  const changes: DisplayChange[] = [];
  for (const field of lastAfter.keys()) {
    const before = firstBefore.get(field) ?? null;
    const after = lastAfter.get(field) ?? null;
    if (before === after) continue; // net no-op (e.g. changed then reverted)
    changes.push({ field, before, after });
  }

  return {
    changes,
    corrections,
    unavailableBeforeFields: [...unavailable].filter((f) => changes.some((c) => c.field === f)),
    correctionCount: corrections.length,
  };
}
