/**
 * Emergency estimation hold — decision logic.
 *
 * A hold is NOT a well being down. `wellDown` means a physical, administrative
 * statement about the well; reusing it for "we cannot reach the drivers" would
 * conflate an outage with equipment state, and clearing it later would clear
 * genuine mark-downs too. So this is a separate, server-owned flag that says
 * only: stop projecting this well forward, we know the estimate is running on
 * stale ground.
 *
 * Stored at `wells/{wellName}/estimationHold` — a stable path, deliberately not
 * on the outgoing response row. Response ids are deleted and recreated on every
 * pull, so writing a hold there could resurrect a row processIncomingPull had
 * just removed, leaving a half-built ghost.
 *
 * IDENTITY-BOUND, which is what makes this safe under concurrency. The hold
 * records the pull it was taken against (`heldAtPullUTC`). A consumer honours it
 * only while that pull is still the well's latest. The instant a real pull lands
 * the timestamp moves, the hold no longer matches, and estimation resumes on the
 * new baseline — with no write, no ordering assumption, and no window in which a
 * freshly pulled well could be hidden from a driver. Server-side clearing on
 * accepted pulls is hygiene on top of that, not the mechanism.
 */

export const HOLD_REASON_MAX = 500;

export interface EstimationHoldRecord {
  active: boolean;
  /** lastPullDateTimeUTC this hold was taken against. The binding. */
  heldAtPullUTC: string;
  /** Response id observed at hold time — evidence only, never a write target. */
  heldAtResponseId?: string;
  heldByUid?: string;
  heldAtMs?: number;
  reason?: string;
}

/**
 * Should a consumer stop estimating this well forward?
 *
 * True only when an active hold is bound to the pull that is still current. A
 * hold left over from an earlier pull is silently ignored — stale evidence must
 * never suppress a live well.
 */
export function holdSuppressesEstimation(
  hold: Partial<EstimationHoldRecord> | null | undefined,
  currentLastPullUTC: string | null | undefined,
): boolean {
  if (!hold || hold.active !== true) return false;
  if (typeof hold.heldAtPullUTC !== 'string' || !hold.heldAtPullUTC) return false;
  if (typeof currentLastPullUTC !== 'string' || !currentLastPullUTC) return false;
  return hold.heldAtPullUTC === currentLastPullUTC;
}

// ── preview / apply ─────────────────────────────────────────────────────────

export interface HoldTarget {
  wellName: string;
  /** The last pull the caller reviewed. Apply refuses if this no longer holds. */
  expectedLastPullUTC: string;
}

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
  config: { companyId?: string; avgFlowRate?: string; avgFlowRateMinutes?: number };
}

export type HoldAction =
  | 'apply_hold'
  | 'skip_already_held'
  | 'skip_physically_down'
  | 'refuse_missing_status'
  | 'refuse_evidence_mismatch';

export interface HoldDecision {
  wellName: string;
  action: HoldAction;
  reason: string;
  /** The single path this well would write. Empty unless action is apply_hold. */
  willWrite: string[];
  observed: {
    responseId: string | null;
    companyId: string | null;
    lastPullDateTimeUTC: string | null;
    lastPullBottomLevel: string | null;
    currentLevel: string | null;
    /** Physical/administrative down state — never modified by this operation. */
    wellDown: boolean;
    holdActive: boolean;
    heldAtPullUTC: string | null;
    avgFlowRate: string | null;
    avgFlowRateMinutes: number | null;
  };
}

export function decideEstimationHold(
  target: HoldTarget,
  observed: HoldObservation,
): HoldDecision {
  const o = observed.outgoing;
  const physicallyDown = o?.wellDown === true || o?.isDown === true || observed.statusIsDown === true;
  const base = {
    wellName: target.wellName,
    observed: {
      responseId: o?.responseId ?? null,
      companyId: observed.config.companyId ?? null,
      lastPullDateTimeUTC: o?.lastPullDateTimeUTC ?? null,
      lastPullBottomLevel: o?.lastPullBottomLevel ?? null,
      currentLevel: o?.currentLevel ?? null,
      wellDown: physicallyDown,
      holdActive: holdSuppressesEstimation(observed.hold, o?.lastPullDateTimeUTC),
      heldAtPullUTC: typeof observed.hold?.heldAtPullUTC === 'string' ? observed.hold.heldAtPullUTC : null,
      avgFlowRate: observed.config.avgFlowRate ?? null,
      avgFlowRateMinutes:
        typeof observed.config.avgFlowRateMinutes === 'number' ? observed.config.avgFlowRateMinutes : null,
    },
  };

  if (!o) {
    return { ...base, action: 'refuse_missing_status', reason: 'no outgoing status row', willWrite: [] };
  }

  // A physically down well is already not estimating. Holding it would add a
  // second reason for the same visible state and muddy the eventual clear.
  if (physicallyDown) {
    return { ...base, action: 'skip_physically_down', reason: 'well is marked physically down', willWrite: [] };
  }

  if (base.observed.holdActive) {
    return { ...base, action: 'skip_already_held', reason: 'hold already active for this pull', willWrite: [] };
  }

  if (
    typeof o.lastPullDateTimeUTC !== 'string' ||
    o.lastPullDateTimeUTC !== target.expectedLastPullUTC
  ) {
    return {
      ...base,
      action: 'refuse_evidence_mismatch',
      reason: `last pull is ${o.lastPullDateTimeUTC ?? '(none)'}, caller reviewed ${target.expectedLastPullUTC}`,
      willWrite: [],
    };
  }

  return {
    ...base,
    action: 'apply_hold',
    reason: 'no replacement pull possible during the WB-M outage; freeze at the last accepted bottom level',
    willWrite: [`wells/${target.wellName}/estimationHold`],
  };
}

// ── identity-bound preview digest ───────────────────────────────────────────

/**
 * Canonical, order-independent serialisation of what the reviewer saw.
 *
 * Apply recomputes this from live state and refuses on any difference, so an
 * approval cannot be replayed against a world that has moved — a new pull, a
 * changed response id, a well marked down in the meantime, all invalidate it.
 * Bound to the caller uid so one reviewer's approval is not another's.
 */
export function previewDigestPayload(callerUid: string, decisions: HoldDecision[]): string {
  const rows = decisions
    .map((d) => [
      d.wellName,
      d.observed.responseId ?? '',
      d.observed.lastPullDateTimeUTC ?? '',
      d.observed.holdActive ? 'held' : 'unheld',
      d.observed.wellDown ? 'down' : 'up',
      d.action,
    ].join(''))
    .sort();
  return [`uid=${callerUid}`, ...rows].join('');
}

/** Digest helper injected so the pure module stays free of node:crypto. */
export type DigestFn = (input: string) => string;

export function computePreviewDigest(
  callerUid: string,
  decisions: HoldDecision[],
  digest: DigestFn,
): string {
  return digest(previewDigestPayload(callerUid, decisions));
}

export interface HoldPlan {
  dryRun: boolean;
  decisions: HoldDecision[];
  counts: Record<HoldAction, number>;
  willWriteCount: number;
  previewDigest: string;
}

export function buildHoldPlan(
  decisions: HoldDecision[],
  dryRun: boolean,
  callerUid: string,
  digest: DigestFn,
): HoldPlan {
  const counts: Record<HoldAction, number> = {
    apply_hold: 0, skip_already_held: 0, skip_physically_down: 0,
    refuse_missing_status: 0, refuse_evidence_mismatch: 0,
  };
  for (const d of decisions) counts[d.action] += 1;
  return {
    dryRun,
    decisions,
    counts,
    willWriteCount: decisions.filter((d) => d.action === 'apply_hold').length,
    previewDigest: computePreviewDigest(callerUid, decisions, digest),
  };
}

export function parseHoldTargets(raw: unknown): HoldTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('targets_required');
  if (raw.length > 200) throw new Error('too_many_targets');
  const seen = new Set<string>();
  return raw.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const wellName = e.wellName;
    const expectedLastPullUTC = e.expectedLastPullUTC;
    if (typeof wellName !== 'string' || !wellName.trim() || wellName.length > 120) {
      throw new Error('invalid_wellName');
    }
    if (/[/.#$[\]]/.test(wellName)) throw new Error('invalid_wellName');
    if (typeof expectedLastPullUTC !== 'string' || Number.isNaN(Date.parse(expectedLastPullUTC))) {
      throw new Error('invalid_expectedLastPullUTC');
    }
    if (seen.has(wellName)) throw new Error('duplicate_well');
    seen.add(wellName);
    return { wellName, expectedLastPullUTC };
  });
}

/**
 * Transaction body for taking a hold.
 *
 * Returns undefined to ABORT when another writer got there first, so two
 * concurrent Applies cannot both claim the same well. The identity binding is
 * written here, which is what later makes a stale hold harmless.
 */
export function holdTransactionUpdate(
  current: Partial<EstimationHoldRecord> | null,
  next: EstimationHoldRecord,
): EstimationHoldRecord | undefined {
  if (current && current.active === true && current.heldAtPullUTC === next.heldAtPullUTC) {
    return undefined; // already held for this exact pull — abort, do not rewrite
  }
  return next;
}
