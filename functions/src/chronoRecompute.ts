// chronoRecompute.ts — pure, injected chronological recomputation engine for a
// single well's pull history. Emulator-free and unit-testable.
//
// Chronology authority is the event/completion time `dateTimeUTC` (the only
// authoritative time field stored today; a distinct pull-START timestamp does
// NOT exist and is recorded as a separate schema/UI follow-up — see
// PULL_START_TIMESTAMP_GAP). Ordering is by dateTimeUTC ascending with a stable,
// deterministic packetId tie-breaker. Server ARRIVAL order is never used.
//
// The engine recomputes DERIVED relationships (predecessor linkage, tank bottom,
// recovery inches, elapsed time, flow rate, bbl/hr·day, next-pull, late-entry &
// anomaly flags) for every pull from its immediate predecessor. It PRESERVES
// each pull's historical material readings (top, bbls, wellDown) and, when a pull
// carries a historical bottom snapshot (`knownBottomInches`), preserves that
// bottom and its own recovery rather than recomputing them with today's config.
//
// No physical-plausibility REJECTION exists here: unusual continuity/timing/
// recovery only raises an anomaly flag; nothing is ever dropped.

export interface WellChronoConfig {
  bblPerFoot: number;
  tanks: number;
  allowedBottomInches?: number;
  /** Well rolling flow rate (days per foot of rise), used only for anomaly banding. */
  avgFlowRateDays?: number;
}

export interface ChronoPullInput {
  packetId: string;
  /** Event/completion time — the chronology authority. */
  dateTimeUTC: string;
  /** Measured top level (inches). Historical material reading — preserved. */
  tankTopInches: number;
  bblsTaken: number;
  wellDown?: boolean;
  /** Server ingest time (ms) — for late-entry reasoning + audit, never ordering. */
  submittedAtMs?: number;
  /** Historical bottom snapshot (inches). When present it is PRESERVED (not
   *  recomputed with today's config) and used as this pull's bottom. */
  knownBottomInches?: number;
}

export interface ChronoPullResult extends ChronoPullInput {
  order: number;
  prevPacketId: string | null;
  tankAfterInches: number;   // bottom (derived, or preserved from knownBottomInches)
  recoveryInches: number;    // max(0, top - prevBottom)
  timeDifDays: number;       // elapsed since predecessor
  flowRateDays: number;      // days per foot of rise
  bblsPerDay: number;        // derived throughput
  isCurrent: boolean;        // newest by event time (owns current/outgoing)
  lateEntry: boolean;        // a newer pull already exists (submitted out of order)
  anomaly: boolean;
  anomalyReasons: string[];
}

/** A distinct pull-start timestamp is NOT stored today — recorded for a later
 *  schema/UI change. Tank-top continuity may inform anomaly reasoning but must
 *  never manufacture an unstored start time. */
export const PULL_START_TIMESTAMP_GAP =
  'No authoritative pull-start timestamp is stored; ordering uses event-time dateTimeUTC. ' +
  'Tank-top continuity assists anomaly detection only, never ordering.';

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeBottomInches(topInches: number, bblsTaken: number, cfg: WellChronoConfig): number {
  const perFoot = cfg.bblPerFoot > 0 ? cfg.bblPerFoot : 20;
  const tanks = cfg.tanks > 0 ? cfg.tanks : 1;
  return topInches - (bblsTaken / perFoot / tanks) * 12;
}

/** Deterministic chronological order: event time asc, then packetId asc. */
export function orderChrono<T extends ChronoPullInput>(pulls: T[]): T[] {
  return [...pulls].sort((a, b) => {
    const ta = Date.parse(a.dateTimeUTC);
    const tb = Date.parse(b.dateTimeUTC);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    // Identical (or unparseable-equal) timestamps → stable packetId tie-break.
    return String(a.packetId) < String(b.packetId) ? -1 : String(a.packetId) > String(b.packetId) ? 1 : 0;
  });
}

function bottomOf(p: ChronoPullInput, cfg: WellChronoConfig): number {
  if (typeof p.knownBottomInches === 'number' && Number.isFinite(p.knownBottomInches)) return p.knownBottomInches;
  return computeBottomInches(p.tankTopInches, p.bblsTaken, cfg);
}

/**
 * Recompute the entire well chain. Every pull's derived relationships are
 * recomputed against its immediate predecessor in chronological order; the
 * newest pull is flagged current. Late-entry = a strictly-newer pull exists.
 * Anomaly = continuity/recovery/flow outside a deterministic band.
 */
export function recomputeWell(
  pulls: ChronoPullInput[],
  cfg: WellChronoConfig,
): ChronoPullResult[] {
  const ordered = orderChrono(pulls);
  const results: ChronoPullResult[] = [];
  const newestMs = ordered.length
    ? Math.max(...ordered.map((p) => Date.parse(p.dateTimeUTC)).filter(Number.isFinite))
    : NaN;

  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const prev = i > 0 ? ordered[i - 1] : null;
    const prevResult = i > 0 ? results[i - 1] : null;
    const top = p.tankTopInches;
    const bottom = bottomOf(p, cfg);

    const prevBottom = prevResult ? prevResult.tankAfterInches : null;
    const recoveryInches = prevBottom === null ? 0 : Math.max(0, top - prevBottom);

    const tMs = Date.parse(p.dateTimeUTC);
    const prevMs = prev ? Date.parse(prev.dateTimeUTC) : NaN;
    const timeDifDays = Number.isFinite(tMs) && Number.isFinite(prevMs) && tMs > prevMs
      ? (tMs - prevMs) / DAY_MS : 0;

    let flowRateDays = 0;
    if (recoveryInches > 0 && timeDifDays > 0) flowRateDays = (timeDifDays / recoveryInches) * 12;
    const bblsPerDay = timeDifDays > 0 ? (p.bblsTaken / timeDifDays) : 0;

    // Late entry: a strictly newer pull exists (this row is not the newest).
    const lateEntry = Number.isFinite(newestMs) && Number.isFinite(tMs) && tMs < newestMs;

    // Anomaly (never a rejection): continuity break or flow far off the well band.
    const anomalyReasons: string[] = [];
    if (prevBottom !== null && top < prevBottom) anomalyReasons.push('tank_continuity_top_below_prev_bottom');
    if (typeof cfg.allowedBottomInches === 'number' && bottom < cfg.allowedBottomInches) anomalyReasons.push('bottom_below_allowed');
    if (recoveryInches > 0 && timeDifDays > 0 && typeof cfg.avgFlowRateDays === 'number' && cfg.avgFlowRateDays > 0) {
      const ratio = flowRateDays / cfg.avgFlowRateDays;
      if (ratio < 0.5 || ratio > 2) anomalyReasons.push('flow_rate_out_of_band');
    }
    if (prevResult && recoveryInches === 0 && timeDifDays > 0 && top <= prevBottom!) {
      anomalyReasons.push('no_recovery_between_pulls');
    }

    results.push({
      ...p,
      order: i,
      prevPacketId: prev ? prev.packetId : null,
      tankAfterInches: bottom,
      recoveryInches,
      timeDifDays,
      flowRateDays,
      bblsPerDay,
      isCurrent: Number.isFinite(tMs) && tMs === newestMs && (i === ordered.length - 1),
      lateEntry,
      anomaly: anomalyReasons.length > 0,
      anomalyReasons,
    });
  }
  return results;
}

/** The current (newest) pull after recomputation, or null when empty. The
 *  watermark follows THIS pull and never regresses to an older insertion. */
export function currentPull(results: ChronoPullResult[]): ChronoPullResult | null {
  return results.find((r) => r.isCurrent) ?? (results.length ? results[results.length - 1] : null);
}

/** Insert or replace a pull by packetId, returning the new set (immutably).
 *  A CREATE inserts; an EDIT (same packetId, changed dateTimeUTC/values) replaces
 *  in place — re-ordering happens in recomputeWell, so the same logical id keeps
 *  its identity while moving chronological position. */
export function upsertPull(pulls: ChronoPullInput[], next: ChronoPullInput): ChronoPullInput[] {
  const rest = pulls.filter((p) => p.packetId !== next.packetId);
  return [...rest, next];
}

/** True when two pulls are the SAME logical pull materially (well-scoped):
 *  same event time + top + bbls + wellDown. Used to make a backdated insert an
 *  idempotent no-op against a logical duplicate. */
export function isLogicalDuplicate(a: ChronoPullInput, b: ChronoPullInput): boolean {
  return a.dateTimeUTC === b.dateTimeUTC
    && Math.round(a.tankTopInches) === Math.round(b.tankTopInches)
    && Number(a.bblsTaken) === Number(b.bblsTaken)
    && Boolean(a.wellDown) === Boolean(b.wellDown);
}

const DERIVED_KEYS = [
  'tankAfterInches', 'recoveryInches', 'timeDifDays', 'flowRateDays', 'bblsPerDay',
  'lateEntry', 'anomaly', 'anomalyReasons', 'prevPacketId',
] as const;

export interface BackdatedCommitPlan {
  /** Single atomic multi-location update for db.ref().update(). */
  updates: Record<string, unknown>;
  /** Newest pull id — owns outgoing/current. */
  currentPacketId: string | null;
  /** Invariant of a backdated insert: the current pointer is unchanged. */
  watermarkRegressed: boolean;
  /** Successor ids whose derived fields changed and were rewritten. */
  changedPacketIds: string[];
  insertedLateEntry: boolean;
  /** True when the new pull is a logical duplicate → idempotent no-op. */
  duplicateNoop: boolean;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Plan the atomic commit for accepting a back-dated CREATE. Diffs the well chain
 * before/after the insert and emits ONE multi-location update that:
 *   - writes the new pull's derived fields (+ lateEntry/anomaly tags) under
 *     packets/processed/<newId>;
 *   - rewrites ONLY the successors whose derived relationships changed;
 *   - carries the new well revision on each touched row for fencing;
 *   - NEVER touches the current/outgoing pointer (watermark cannot regress).
 * A logical-duplicate insert returns duplicateNoop with an empty update.
 */
export function planBackdatedCommit(args: {
  before: ChronoPullResult[];
  after: ChronoPullResult[];
  newPacketId: string;
  wellRevision: number;
  processedBasePath?: string;
}): BackdatedCommitPlan {
  const base = args.processedBasePath ?? 'packets/processed';
  const beforeById = new Map(args.before.map((r) => [r.packetId, r]));
  const currentBefore = currentPull(args.before)?.packetId ?? null;
  const currentAfter = currentPull(args.after)?.packetId ?? null;

  // Logical duplicate → no-op (idempotent). The new id equals an existing row's
  // material content at the same time.
  const newRow = args.after.find((r) => r.packetId === args.newPacketId);
  const dup = !!newRow && args.before.some((b) => isLogicalDuplicate(b, newRow));
  if (dup) {
    return { updates: {}, currentPacketId: currentAfter, watermarkRegressed: false, changedPacketIds: [], insertedLateEntry: false, duplicateNoop: true };
  }

  const updates: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const row of args.after) {
    const prev = beforeById.get(row.packetId);
    const isNew = row.packetId === args.newPacketId;
    let dirty = isNew;
    if (!isNew && prev) {
      for (const k of DERIVED_KEYS) {
        const a = JSON.stringify((row as unknown as Record<string, unknown>)[k]);
        const b = JSON.stringify((prev as unknown as Record<string, unknown>)[k]);
        if (a !== b) { dirty = true; break; }
      }
    }
    if (!dirty) continue;
    if (!isNew) changed.push(row.packetId);
    const p = `${base}/${row.packetId}`;
    updates[`${p}/tankAfterInches`] = round(row.tankAfterInches);
    updates[`${p}/recoveryInches`] = round(row.recoveryInches);
    updates[`${p}/timeDifDays`] = round(row.timeDifDays);
    updates[`${p}/flowRateDays`] = round(row.flowRateDays);
    updates[`${p}/lateEntry`] = row.lateEntry;
    updates[`${p}/anomaly`] = row.anomaly;
    updates[`${p}/anomalyReasons`] = row.anomalyReasons;
    updates[`${p}/chronoRevision`] = args.wellRevision;
  }

  return {
    updates,
    currentPacketId: currentAfter,
    // A backdated insert never makes the new pull newest, so current is unchanged.
    watermarkRegressed: currentBefore !== null && currentAfter !== currentBefore,
    changedPacketIds: changed,
    insertedLateEntry: !!newRow?.lateEntry,
    duplicateNoop: false,
  };
}
