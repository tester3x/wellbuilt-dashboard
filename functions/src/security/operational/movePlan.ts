/**
 * Pure recompute/planning helpers for a governed pull move. No Firebase I/O so
 * every branch is unit-testable. The move trigger composes these to recompute
 * BOTH wells from their live history — deriving from the latest remaining pull
 * (never regressing to older state) and re-measuring the moved pull's flow rate
 * against its NEW well's prior pull.
 *
 * Field math mirrors processIncomingPull: tankAfter = tankTop - (bbls/20/tanks)*12,
 * recovery = max(0, tankTop - prevTankAfter), flowRateDays = (days/recovery)*12,
 * with the same 365-day anomaly rejection.
 */
export interface PullRow {
  packetId: string;
  dateTimeUTC?: string;
  tankTopInches?: number;
  tankAfterInches?: number;
  bblsTaken?: number;
  flowRateDays?: number;
  wellName?: string;
}

const DAY_MS = 1000 * 60 * 60 * 24;
const MAX_FLOW_DAYS = 365; // days/ft above this is treated as anomalous → 0

export function timeMs(dateTimeUTC?: string): number {
  if (!dateTimeUTC) return NaN;
  const t = new Date(dateTimeUTC).getTime();
  return Number.isNaN(t) ? NaN : t;
}

/** The well's current-state anchor: the pull with the newest valid dateTimeUTC. */
export function selectLatestPull(pulls: PullRow[]): PullRow | null {
  let latest: PullRow | null = null;
  let latestMs = -Infinity;
  for (const p of pulls) {
    const ms = timeMs(p.dateTimeUTC);
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latest = p;
    }
  }
  return latest;
}

/** The pull immediately before/after a pivot time (exclusive), among `pulls`. */
export function findAdjacent(
  pulls: PullRow[],
  pivotMs: number,
): { prev: PullRow | null; next: PullRow | null } {
  let prev: PullRow | null = null;
  let prevMs = -Infinity;
  let next: PullRow | null = null;
  let nextMs = Infinity;
  for (const p of pulls) {
    const ms = timeMs(p.dateTimeUTC);
    if (Number.isNaN(ms)) continue;
    if (ms < pivotMs && ms > prevMs) { prevMs = ms; prev = p; }
    if (ms > pivotMs && ms < nextMs) { nextMs = ms; next = p; }
  }
  return { prev, next };
}

export function tankAfterInches(tankTopInches: number, bblsTaken: number, tanks: number): number {
  const safeTanks = tanks > 0 ? tanks : 1;
  const bblsInInches = (bblsTaken / 20 / safeTanks) * 12;
  return tankTopInches - bblsInInches;
}

export interface RecomputedFields {
  timeDifDays: number;
  recoveryInches: number;
  flowRateDays: number;
}

/**
 * Recompute a pull's own recovery/flow-rate against the pull that precedes it in
 * the target well. With no prior pull, recovery/flow are 0 (first pull of well).
 */
export function recomputeAgainstPrior(
  pull: { dateTimeUTC?: string; tankTopInches?: number },
  prior: { dateTimeUTC?: string; tankAfterInches?: number } | null,
): RecomputedFields {
  const tankTop = typeof pull.tankTopInches === 'number' ? pull.tankTopInches : 0;
  const thisMs = timeMs(pull.dateTimeUTC);
  if (!prior) return { timeDifDays: 0, recoveryInches: 0, flowRateDays: 0 };
  const priorMs = timeMs(prior.dateTimeUTC);
  const priorAfter = typeof prior.tankAfterInches === 'number' ? prior.tankAfterInches : 0;
  const timeDifDays =
    !Number.isNaN(thisMs) && !Number.isNaN(priorMs) && thisMs > priorMs
      ? (thisMs - priorMs) / DAY_MS
      : 0;
  const recoveryInches = priorAfter > 0 && tankTop > 0 ? Math.max(0, tankTop - priorAfter) : 0;
  let flowRateDays = 0;
  if (recoveryInches > 0 && timeDifDays > 0) {
    const fr = (timeDifDays / recoveryInches) * 12;
    flowRateDays = fr >= MAX_FLOW_DAYS ? 0 : fr;
  }
  return { timeDifDays, recoveryInches, flowRateDays };
}

/** Underscore-keyed performance node key (spaces → underscores). */
export function wellPerfKey(wellName: string): string {
  return wellName.replace(/\s+/g, '_');
}

/** Local-time performance row key derived from the pull's dateTimeUTC. */
export function perfRowKey(dateTimeUTC: string): string {
  const d = new Date(dateTimeUTC);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/**
 * The move plan for one execution: which pull anchors each well's rebuild after
 * the moved pull is re-anchored fromWell→toWell. `fromPulls`/`toPulls` are the
 * live histories AFTER the wellName change (fromPulls excludes the moved pull;
 * toPulls includes it). Deriving each well from its latest pull guarantees a
 * concurrent newer pull is honored, never regressed.
 */
export function planMove(args: {
  movedPacketId: string;
  fromPulls: PullRow[];
  toPulls: PullRow[];
}): {
  fromLatest: PullRow | null;
  toLatest: PullRow | null;
  fromEmpty: boolean;
} {
  const fromLatest = selectLatestPull(args.fromPulls);
  const toLatest = selectLatestPull(args.toPulls);
  return { fromLatest, toLatest, fromEmpty: args.fromPulls.length === 0 };
}
