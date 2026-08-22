/**
 * Emergency estimation hold — decision logic.
 *
 * A hold is NOT a well being down. `wellDown` is a physical, administrative
 * statement about the well; borrowing it to mean "we cannot reach the drivers"
 * conflates two different things and makes the eventual clear ambiguous. So this
 * is a separate, server-owned flag saying only: stop projecting this well
 * forward, the estimate is running on ground we can no longer refresh.
 *
 * Stored at `wells/{wellName}/estimationHold` — a stable path, deliberately not
 * on the outgoing response row, which is deleted and recreated on every pull.
 *
 * SELECTION IS THE WELL'S OWN HISTORY, not a model of it. For every well in the
 * pool we read the accepted production pulls, sort them, take the intervals
 * between consecutive pulls, and average those. A well is overdue when the time
 * since its latest accepted pull exceeds its own average interval. No flow rate
 * is required and no well is pre-filtered as "dormant" — a well that is pulled
 * every three weeks is simply a well with a three-week average, and it is
 * overdue on its own terms or it is not.
 *
 * IDENTITY-BOUND, which is what makes it safe under concurrency. The hold
 * records the pull it was taken against. A consumer honours it only while that
 * is still the well's latest pull, so the instant a real pull lands the hold
 * stops applying — no write, no ordering assumption, no window in which a
 * freshly pulled well stays frozen.
 */

export const HOLD_REASON_MAX = 500;
/** Fewest accepted pulls that can yield an average interval worth acting on. */
export const MIN_PULLS_FOR_AVERAGE = 3;

export interface EstimationHoldRecord {
  active: boolean;
  /** lastPullDateTimeUTC this hold was taken against. The binding. */
  heldAtPullUTC: string;
  heldAtResponseId?: string;
  heldByUid?: string;
  heldAtMs?: number;
  /** Apply operation that wrote this hold — ownership for compensation. */
  applyOpId?: string;
  reason?: string;
}

export function holdSuppressesEstimation(
  hold: Partial<EstimationHoldRecord> | null | undefined,
  currentLastPullUTC: string | null | undefined,
): boolean {
  if (!hold || hold.active !== true) return false;
  if (typeof hold.heldAtPullUTC !== 'string' || !hold.heldAtPullUTC) return false;
  if (typeof currentLastPullUTC !== 'string' || !currentLastPullUTC) return false;
  return hold.heldAtPullUTC === currentLastPullUTC;
}

/**
 * Exact fingerprint of the hold state observed at Preview.
 *
 * Apply's transaction aborts unless the live hold still fingerprints to this,
 * so a *different* or *newer* hold can never be overwritten — only the precise
 * state the reviewer saw may be replaced.
 */
export function holdFingerprint(hold: Partial<EstimationHoldRecord> | null | undefined): string {
  if (!hold || typeof hold !== 'object') return 'none';
  if (hold.active !== true) return 'inactive';
  return [
    'active',
    hold.heldAtPullUTC ?? '',
    hold.heldAtResponseId ?? '',
    hold.applyOpId ?? '',
    hold.heldAtMs != null ? String(hold.heldAtMs) : '',
  ].join('|');
}

// ── pull-history statistics ─────────────────────────────────────────────────

export interface PullIntervalStats {
  /** Accepted pull timestamps used, ascending, as epoch ms. */
  pullCount: number;
  latestPullMs: number | null;
  latestPullUTC: string | null;
  /** Gaps between consecutive accepted pulls, ms. */
  intervalCount: number;
  /** Arithmetic mean of those gaps, ms. Null when there are none. */
  averageIntervalMs: number | null;
}

/**
 * Sort the accepted pulls, difference consecutive pairs, and take the plain
 * arithmetic mean — the average the operator would compute by hand.
 *
 * Non-finite and duplicate timestamps are dropped: a duplicate would contribute
 * a zero-length interval and drag the average down, making a well look overdue
 * sooner than its real cadence warrants.
 */
export function computePullIntervalStats(timestampsMs: number[]): PullIntervalStats {
  const sorted = Array.from(new Set(timestampsMs.filter((t) => Number.isFinite(t) && t > 0)))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { pullCount: 0, latestPullMs: null, latestPullUTC: null, intervalCount: 0, averageIntervalMs: null };
  }
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) intervals.push(sorted[i] - sorted[i - 1]);
  const latestPullMs = sorted[sorted.length - 1];
  return {
    pullCount: sorted.length,
    latestPullMs,
    latestPullUTC: new Date(latestPullMs).toISOString(),
    intervalCount: intervals.length,
    averageIntervalMs: intervals.length
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : null,
  };
}

/** `X'Y"` to inches. 0 means unusable — never a valid freeze point. */
export function parseBottomInches(raw: unknown): number {
  if (typeof raw !== 'string') return 0;
  const m = raw.match(/(\d+)'(\d+)"/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 12 + parseInt(m[2], 10);
}

// ── per-well decision ───────────────────────────────────────────────────────

export interface HoldObservation {
  outgoing: {
    responseId: string;
    lastPullDateTimeUTC?: string;
    lastPullBottomLevel?: string;
    currentLevel?: string;
    wellDown?: boolean;
    isDown?: boolean;
  } | null;
  statusIsDown: boolean;
  hold: Partial<EstimationHoldRecord> | null;
  /** Accepted production-pull timestamps for this well, epoch ms, any order. */
  acceptedPullMs: number[];
  config: { companyId?: string; avgFlowRate?: string; avgFlowRateMinutes?: number };
}

export type HoldAction =
  | 'apply_hold'
  | 'skip_within_average'
  | 'skip_physically_down'
  | 'skip_already_held'
  | 'insufficient_history'
  | 'refuse_missing_status'
  | 'refuse_missing_bottom';

export interface HoldDecision {
  wellName: string;
  action: HoldAction;
  reason: string;
  willWrite: string[];
  observed: {
    responseId: string | null;
    companyId: string | null;
    /** Latest accepted pull per the OUTGOING row — the hold binding target. */
    lastPullDateTimeUTC: string | null;
    lastPullBottomLevel: string | null;
    lastPullBottomInches: number | null;
    currentLevel: string | null;
    wellDown: boolean;
    holdActive: boolean;
    holdFingerprint: string;
    avgFlowRate: string | null;
    avgFlowRateMinutes: number | null;
  };
  /** The arithmetic the proposal rests on, exposed for the reviewer. */
  history: {
    pullCount: number;
    intervalCount: number;
    averageIntervalMs: number | null;
    averageIntervalHours: number | null;
    latestPullUTC: string | null;
    elapsedMs: number | null;
    elapsedHours: number | null;
    overdueRatio: number | null;
  };
}

/**
 * Decide one well against a fixed `asOfMs`.
 *
 * Pure: same inputs, same decision, no clock. Every well in the pool reaches
 * here — physically down wells and wells with thin history are reported, not
 * silently dropped, because "not proposed" and "not examined" must be
 * distinguishable to whoever reviews this.
 */
export function decideEstimationHold(input: {
  wellName: string;
  asOfMs: number;
  observed: HoldObservation;
}): HoldDecision {
  const { wellName, asOfMs, observed } = input;
  const o = observed.outgoing;
  const stats = computePullIntervalStats(observed.acceptedPullMs);
  const physicallyDown = o?.wellDown === true || o?.isDown === true || observed.statusIsDown === true;
  const bottomInches = parseBottomInches(o?.lastPullBottomLevel);
  const elapsedMs = stats.latestPullMs === null ? null : Math.max(0, asOfMs - stats.latestPullMs);

  const base = {
    wellName,
    observed: {
      responseId: o?.responseId ?? null,
      companyId: observed.config.companyId ?? null,
      lastPullDateTimeUTC: o?.lastPullDateTimeUTC ?? null,
      lastPullBottomLevel: o?.lastPullBottomLevel ?? null,
      lastPullBottomInches: bottomInches > 0 ? bottomInches : null,
      currentLevel: o?.currentLevel ?? null,
      wellDown: physicallyDown,
      holdActive: holdSuppressesEstimation(observed.hold, o?.lastPullDateTimeUTC),
      holdFingerprint: holdFingerprint(observed.hold),
      avgFlowRate: observed.config.avgFlowRate ?? null,
      avgFlowRateMinutes:
        typeof observed.config.avgFlowRateMinutes === 'number' ? observed.config.avgFlowRateMinutes : null,
    },
    history: {
      pullCount: stats.pullCount,
      intervalCount: stats.intervalCount,
      averageIntervalMs: stats.averageIntervalMs,
      averageIntervalHours: stats.averageIntervalMs === null
        ? null : Math.round((stats.averageIntervalMs / 3_600_000) * 100) / 100,
      latestPullUTC: stats.latestPullUTC,
      elapsedMs,
      elapsedHours: elapsedMs === null ? null : Math.round((elapsedMs / 3_600_000) * 100) / 100,
      overdueRatio: (elapsedMs !== null && stats.averageIntervalMs)
        ? Math.round((elapsedMs / stats.averageIntervalMs) * 1000) / 1000 : null,
    },
  };

  if (!o) {
    return { ...base, action: 'refuse_missing_status', reason: 'no outgoing status row', willWrite: [] };
  }

  // Reported, never held. A down well already is not estimating; adding a hold
  // would give one visible state two causes and muddle the eventual clear.
  if (physicallyDown) {
    return {
      ...base,
      action: 'skip_physically_down',
      reason: 'physically down — evaluated and reported, left physically down without a hold',
      willWrite: [],
    };
  }

  if (base.observed.holdActive) {
    return { ...base, action: 'skip_already_held', reason: 'hold already active for this pull', willWrite: [] };
  }

  if (stats.pullCount < MIN_PULLS_FOR_AVERAGE || stats.averageIntervalMs === null || elapsedMs === null) {
    return {
      ...base,
      action: 'insufficient_history',
      reason:
        `only ${stats.pullCount} accepted pull(s) and ${stats.intervalCount} interval(s); ` +
        `need ${MIN_PULLS_FOR_AVERAGE} pulls for an average — manual review`,
      willWrite: [],
    };
  }

  if (elapsedMs <= stats.averageIntervalMs) {
    return {
      ...base,
      action: 'skip_within_average',
      reason: 'elapsed time is within this well\'s own average pull interval',
      willWrite: [],
    };
  }

  // A freeze needs somewhere real to freeze AT. currentLevel is the running
  // estimate — falling back to it would pin the well to a projected number,
  // which is precisely the value the hold exists to stop trusting.
  if (bottomInches <= 0) {
    return {
      ...base,
      action: 'refuse_missing_bottom',
      reason: `lastPullBottomLevel is ${o.lastPullBottomLevel ?? '(missing)'} — no valid freeze point`,
      willWrite: [],
    };
  }

  return {
    ...base,
    action: 'apply_hold',
    reason:
      `elapsed ${base.history.elapsedHours}h exceeds this well's average pull interval ` +
      `${base.history.averageIntervalHours}h over ${stats.intervalCount} interval(s)`,
    willWrite: [`wells/${wellName}/estimationHold`],
  };
}

// ── identity-bound preview digest ───────────────────────────────────────────

/**
 * Canonical serialisation of the evidence and the proposal.
 *
 * Apply recomputes this from a fresh read and refuses on any difference, so an
 * approval cannot be replayed against a world that has moved. Everything the
 * decision rested on is inside: the asOf it was computed at, the history
 * evidence and count, the average, the latest-pull identity, the exact bottom,
 * the precise existing hold state, the physical state, and the action.
 */
export function previewDigestPayload(
  callerUid: string,
  asOfMs: number,
  decisions: HoldDecision[],
): string {
  const rows = decisions
    .map((d) => [
      d.wellName,
      d.observed.responseId ?? '',
      d.observed.lastPullDateTimeUTC ?? '',
      String(d.observed.lastPullBottomInches ?? ''),
      d.observed.holdFingerprint,
      d.observed.wellDown ? 'down' : 'up',
      String(d.history.pullCount),
      String(d.history.intervalCount),
      d.history.averageIntervalMs === null ? '' : String(Math.round(d.history.averageIntervalMs)),
      d.history.latestPullUTC ?? '',
      d.history.elapsedMs === null ? '' : String(d.history.elapsedMs),
      d.action,
    ].join('|'))
    .sort();
  return [`uid=${callerUid}`, `asOf=${asOfMs}`, ...rows].join('\n');
}

export type DigestFn = (input: string) => string;

export function computePreviewDigest(
  callerUid: string, asOfMs: number, decisions: HoldDecision[], digest: DigestFn,
): string {
  return digest(previewDigestPayload(callerUid, asOfMs, decisions));
}

export interface HoldPlan {
  dryRun: boolean;
  asOfMs: number;
  asOfUTC: string;
  decisions: HoldDecision[];
  counts: Record<HoldAction, number>;
  willWriteCount: number;
  previewDigest: string;
}

export function buildHoldPlan(input: {
  decisions: HoldDecision[];
  dryRun: boolean;
  callerUid: string;
  asOfMs: number;
  digest: DigestFn;
}): HoldPlan {
  const { decisions, dryRun, callerUid, asOfMs, digest } = input;
  const counts: Record<HoldAction, number> = {
    apply_hold: 0, skip_within_average: 0, skip_physically_down: 0, skip_already_held: 0,
    insufficient_history: 0, refuse_missing_status: 0, refuse_missing_bottom: 0,
  };
  for (const d of decisions) counts[d.action] += 1;
  return {
    dryRun,
    asOfMs,
    asOfUTC: new Date(asOfMs).toISOString(),
    decisions,
    counts,
    willWriteCount: decisions.filter((d) => d.action === 'apply_hold').length,
    previewDigest: computePreviewDigest(callerUid, asOfMs, decisions, digest),
  };
}

// ── compare-and-commit ──────────────────────────────────────────────────────

/**
 * Transaction body: replace the hold ONLY if it is still exactly what Preview
 * saw. Any drift — a newer hold, a different pull, another operator's write,
 * even a re-taken hold with a new timestamp — aborts.
 *
 * Returning `undefined` aborts the RTDB transaction without writing.
 */
export function holdCompareAndSet(
  current: Partial<EstimationHoldRecord> | null,
  expectedFingerprint: string,
  next: EstimationHoldRecord,
): EstimationHoldRecord | undefined {
  return holdFingerprint(current) === expectedFingerprint ? next : undefined;
}

/**
 * Compensation body: remove a hold only if THIS apply wrote it.
 *
 * Ownership is checked by applyOpId so rolling back a partially applied batch
 * can never delete a hold that belongs to someone else's operation.
 */
export function holdCompensate(
  current: Partial<EstimationHoldRecord> | null,
  applyOpId: string,
): null | undefined {
  if (!current || typeof current !== 'object') return undefined;
  return current.applyOpId === applyOpId ? null : undefined;
}
