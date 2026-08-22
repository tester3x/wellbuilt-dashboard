/**
 * Emergency estimation hold — decision logic.
 *
 * A hold is NOT a well being down. `wellDown` is a physical, administrative
 * statement about the well; borrowing it to mean "we cannot reach the drivers"
 * conflates two different things and makes the eventual clear ambiguous. So this
 * is a separate, server-owned flag saying only: stop projecting this well
 * forward, the estimate is running on ground we can no longer refresh.
 *
 * Stored under a single `emergencyHolds` root rather than one flag per well.
 * That is what lets the whole reviewed set be taken in ONE transaction: the
 * batch either commits entirely or writes nothing at all, with no compensation
 * pass that could itself fail and strand a partial state.
 *
 * SELECTION IS THE WELL'S OWN HISTORY. For every well in the pool we read the
 * accepted production pulls, sort them, difference consecutive pairs, and
 * average those gaps. A well is overdue when time since its latest accepted
 * pull exceeds its own average. No flow rate is required, and no well is
 * pre-filtered as "dormant" — a well pulled every three weeks simply has a
 * three-week average.
 *
 * IDENTITY-BOUND. The hold records the pull it was taken against, and consumers
 * honour it only while that is still the well's latest pull — so a real pull
 * releases it with no write and no ordering assumption.
 */

export const HOLD_REASON_MAX = 500;

/**
 * Two accepted pulls give one interval, which is an average.
 *
 * Mike's rule is the average gap between accepted pulls; a previous revision of
 * this file required three pulls, which was an invented policy, not his.
 */
export const MIN_PULLS_FOR_AVERAGE = 2;

export const HOLD_ROOT = 'emergencyHolds';

export interface EstimationHoldRecord {
  active: boolean;
  /** The well name as canonically resolved, for humans reading the node. */
  wellName?: string;
  /** lastPullDateTimeUTC this hold was taken against. The binding. */
  heldAtPullUTC: string;
  heldAtResponseId?: string;
  heldByUid?: string;
  heldAtMs?: number;
  applyOpId?: string;
  reason?: string;
}

// ── well identity ───────────────────────────────────────────────────────────

/**
 * One key per real well, across every node that names wells differently.
 *
 * `well_config` uses "Gabriel 1", legacy rows and response ids use "Gabriel1",
 * and processIncomingPull itself falls back between the two. Without a single
 * join key, one well's history, physical-down state and hold end up on
 * different records — which is how a well gets held while its own pull history
 * sits under another name.
 */
export function canonicalWellKey(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.replace(/\s+/g, '').toLowerCase();
}

export interface IdentityResolution {
  /** canonical key -> the display name to use. */
  canonicalName: Map<string, string>;
  /** canonical key -> every distinct config name that collapsed onto it. */
  collisions: Map<string, string[]>;
}

/**
 * Resolve display names, and refuse to guess when two CONFIGURED wells collapse.
 *
 * `well_config` is the authority on what a well is. If it lists both "Gabriel 1"
 * and "Gabriel1" as separate wells, they may genuinely be two wells with an
 * unfortunate naming clash — merging them would blend two histories, and
 * picking one would hide the other. Those are reported and refused. Variants
 * seen only in status/history are joined onto the configured name, which is the
 * normal legacy case.
 */
export function resolveWellIdentity(input: {
  configNames: string[];
  otherNames: string[];
}): IdentityResolution {
  const canonicalName = new Map<string, string>();
  const configByKey = new Map<string, Set<string>>();

  for (const name of input.configNames) {
    const key = canonicalWellKey(name);
    if (!key) continue;
    const set = configByKey.get(key) ?? new Set<string>();
    set.add(name);
    configByKey.set(key, set);
  }

  const collisions = new Map<string, string[]>();
  for (const [key, names] of configByKey) {
    if (names.size > 1) collisions.set(key, Array.from(names).sort());
    else canonicalName.set(key, Array.from(names)[0]);
  }

  // Names seen only outside config adopt their own spelling — but never
  // override a configured name, and never resurrect a collided key.
  for (const name of input.otherNames) {
    const key = canonicalWellKey(name);
    if (!key || collisions.has(key) || canonicalName.has(key)) continue;
    canonicalName.set(key, name);
  }

  return { canonicalName, collisions };
}

// ── accepted production pulls ───────────────────────────────────────────────

export type PullRejectReason =
  | 'edit_or_delete_key'
  | 'non_pull_request_type'
  | 'no_level_service_packet'
  | 'no_tank_level'
  | 'invalid_timestamp'
  | 'missing_well';

export type PullClassification =
  | { accepted: true; wellName: string; wellKey: string; timestampMs: number }
  | { accepted: false; reason: PullRejectReason };

/** Keys the pull processor never writes for a production pull. */
const NON_PULL_KEY = /^(edit|delete|history)[_-]/i;

/**
 * Is this `packets/processed` record an accepted production tank pull?
 *
 * Takes the KEY as well as the value, because the key is load-bearing evidence:
 * 23 live `edit_*`/`delete_*` records carry no `requestType` at all, and a
 * value-only reader that defaults missing `requestType` to "pull" counts every
 * one of them as a pull — inflating a well's history with corrections and
 * deletions and dragging its average interval down.
 *
 * A missing `requestType` is still honoured for genuine legacy production
 * pulls, which are plain-keyed and carry a real tank reading.
 */
export function classifyProcessedRecord(key: string, value: unknown): PullClassification {
  if (typeof key === 'string' && NON_PULL_KEY.test(key)) {
    return { accepted: false, reason: 'edit_or_delete_key' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { accepted: false, reason: 'missing_well' };
  }
  const v = value as Record<string, unknown>;

  // Present-and-not-pull is decisive. Absent stays eligible for legacy rows.
  if (v.requestType !== undefined && v.requestType !== 'pull') {
    return { accepted: false, reason: 'non_pull_request_type' };
  }
  if (v.noLevel === true) return { accepted: false, reason: 'no_level_service_packet' };

  const wellName = typeof v.wellName === 'string' ? v.wellName.trim() : '';
  if (!wellName) return { accepted: false, reason: 'missing_well' };

  // The processor's own test for a usable pull: a positive tank top. Legacy
  // rows predate tankTopInches but carry the raw tankLevelFeet it derives from.
  const top = typeof v.tankTopInches === 'number' ? v.tankTopInches : undefined;
  const feet = typeof v.tankLevelFeet === 'number'
    ? v.tankLevelFeet
    : typeof v.tankLevelFeet === 'string' ? parseFloat(v.tankLevelFeet) : undefined;
  const hasLevel = (top !== undefined && top > 0)
    || (top === undefined && feet !== undefined && Number.isFinite(feet) && feet > 0);
  if (!hasLevel) return { accepted: false, reason: 'no_tank_level' };

  const ts = typeof v.dateTimeUTC === 'string' ? Date.parse(v.dateTimeUTC) : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return { accepted: false, reason: 'invalid_timestamp' };

  return { accepted: true, wellName, wellKey: canonicalWellKey(wellName), timestampMs: ts };
}

/** Group accepted pull timestamps by canonical well key. */
export function collectAcceptedPulls(
  records: Array<{ key: string; value: unknown }>,
): { byWellKey: Map<string, number[]>; rejected: Record<PullRejectReason, number> } {
  const byWellKey = new Map<string, number[]>();
  const rejected: Record<PullRejectReason, number> = {
    edit_or_delete_key: 0, non_pull_request_type: 0, no_level_service_packet: 0,
    no_tank_level: 0, invalid_timestamp: 0, missing_well: 0,
  };
  for (const { key, value } of records) {
    const c = classifyProcessedRecord(key, value);
    if (!c.accepted) { rejected[c.reason] += 1; continue; }
    const list = byWellKey.get(c.wellKey);
    if (list) list.push(c.timestampMs); else byWellKey.set(c.wellKey, [c.timestampMs]);
  }
  return { byWellKey, rejected };
}

// ── statistics ──────────────────────────────────────────────────────────────

export interface PullIntervalStats {
  pullCount: number;
  latestPullMs: number | null;
  latestPullUTC: string | null;
  intervalCount: number;
  averageIntervalMs: number | null;
}

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
    averageIntervalMs: intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null,
  };
}

export function parseBottomInches(raw: unknown): number {
  if (typeof raw !== 'string') return 0;
  const m = raw.match(/(\d+)'(\d+)"/);
  return m ? parseInt(m[1], 10) * 12 + parseInt(m[2], 10) : 0;
}

export function holdSuppressesEstimation(
  hold: unknown,
  currentLastPullUTC: string | null | undefined,
): boolean {
  if (!hold || typeof hold !== 'object' || Array.isArray(hold)) return false;
  const h = hold as Partial<EstimationHoldRecord>;
  if (h.active !== true) return false;
  if (typeof h.heldAtPullUTC !== 'string' || !h.heldAtPullUTC) return false;
  if (typeof currentLastPullUTC !== 'string' || !currentLastPullUTC) return false;
  return h.heldAtPullUTC === currentLastPullUTC;
}

/** Exact fingerprint of observed hold state — the compare in compare-and-set. */
/**
 * Deterministic serialisation of ANY value, for exact comparison.
 *
 * Object keys are sorted recursively so two records that differ only in
 * insertion order fingerprint identically, while arrays keep their order
 * because order is meaningful in one. `undefined` and `null` get distinct
 * sentinels — inside an object, a key present-but-null is a different fact
 * from a key that is absent, and both differ from a key holding a value.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return '#undef';
  if (value === null) return '#null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',');
    return `{${body}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return `#num:${String(value)}`;
  return JSON.stringify(value) ?? `#unser:${typeof value}`;
}

/**
 * Exact fingerprint of the hold value observed at Preview — the compare in
 * compare-and-set.
 *
 * This is the WHOLE value, not a chosen subset. An earlier version hashed five
 * named fields and folded every inactive or malformed object into the literal
 * "inactive", which meant a record differing only in `reason`, `heldByUid`,
 * `wellName` or some field added later fingerprinted the same — so concurrent
 * metadata drift passed the transaction check and was silently overwritten.
 * Anything present in the node participates now, including keys this code does
 * not know about.
 */
export function holdFingerprint(hold: unknown): string {
  if (hold === undefined) return '#absent';
  return canonicalJson(hold);
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
  /** Raw stored value — fingerprinted whole, so keep it exactly as read. */
  hold: unknown;
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
  | 'refuse_missing_bottom'
  | 'refuse_ambiguous_identity';

export interface HoldDecision {
  wellKey: string;
  wellName: string;
  action: HoldAction;
  reason: string;
  willWrite: string[];
  observed: {
    responseId: string | null;
    companyId: string | null;
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

/** A configured-name collision: reported, never resolved by guessing. */
export function ambiguousIdentityDecision(wellKey: string, names: string[]): HoldDecision {
  return {
    wellKey,
    wellName: names.join(' | '),
    action: 'refuse_ambiguous_identity',
    reason:
      `well_config lists ${names.length} wells that normalise to "${wellKey}" (${names.join(', ')}); ` +
      'refusing rather than merging two histories or hiding one',
    willWrite: [],
    observed: {
      responseId: null, companyId: null, lastPullDateTimeUTC: null, lastPullBottomLevel: null,
      lastPullBottomInches: null, currentLevel: null, wellDown: false, holdActive: false,
      holdFingerprint: 'none', avgFlowRate: null, avgFlowRateMinutes: null,
    },
    history: {
      pullCount: 0, intervalCount: 0, averageIntervalMs: null, averageIntervalHours: null,
      latestPullUTC: null, elapsedMs: null, elapsedHours: null, overdueRatio: null,
    },
  };
}

export function decideEstimationHold(input: {
  wellKey: string;
  wellName: string;
  asOfMs: number;
  observed: HoldObservation;
}): HoldDecision {
  const { wellKey, wellName, asOfMs, observed } = input;
  const o = observed.outgoing;
  const stats = computePullIntervalStats(observed.acceptedPullMs);
  const physicallyDown = o?.wellDown === true || o?.isDown === true || observed.statusIsDown === true;
  const bottomInches = parseBottomInches(o?.lastPullBottomLevel);
  const elapsedMs = stats.latestPullMs === null ? null : Math.max(0, asOfMs - stats.latestPullMs);

  const base = {
    wellKey,
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

  if (!o) return { ...base, action: 'refuse_missing_status', reason: 'no outgoing status row', willWrite: [] };

  if (physicallyDown) {
    return {
      ...base, action: 'skip_physically_down',
      reason: 'physically down — evaluated and reported, left physically down without a hold',
      willWrite: [],
    };
  }
  if (base.observed.holdActive) {
    return { ...base, action: 'skip_already_held', reason: 'hold already active for this pull', willWrite: [] };
  }
  if (stats.pullCount < MIN_PULLS_FOR_AVERAGE || stats.averageIntervalMs === null || elapsedMs === null) {
    return {
      ...base, action: 'insufficient_history',
      reason:
        `${stats.pullCount} accepted pull(s), ${stats.intervalCount} interval(s); ` +
        `need ${MIN_PULLS_FOR_AVERAGE} pulls for an average — manual review`,
      willWrite: [],
    };
  }
  if (elapsedMs <= stats.averageIntervalMs) {
    return {
      ...base, action: 'skip_within_average',
      reason: "elapsed time is within this well's own average pull interval", willWrite: [],
    };
  }
  if (bottomInches <= 0) {
    return {
      ...base, action: 'refuse_missing_bottom',
      reason: `lastPullBottomLevel is ${o.lastPullBottomLevel ?? '(missing)'} — no valid freeze point`,
      willWrite: [],
    };
  }
  return {
    ...base, action: 'apply_hold',
    reason:
      `elapsed ${base.history.elapsedHours}h exceeds this well's average pull interval ` +
      `${base.history.averageIntervalHours}h over ${stats.intervalCount} interval(s)`,
    willWrite: [`${HOLD_ROOT}/${wellKey}`],
  };
}

// ── digest ──────────────────────────────────────────────────────────────────

export function previewDigestPayload(
  callerUid: string, asOfMs: number, decisions: HoldDecision[],
): string {
  const rows = decisions
    .map((d) => [
      d.wellKey, d.wellName, d.observed.responseId ?? '', d.observed.lastPullDateTimeUTC ?? '',
      String(d.observed.lastPullBottomInches ?? ''), d.observed.holdFingerprint,
      d.observed.wellDown ? 'down' : 'up', String(d.history.pullCount), String(d.history.intervalCount),
      d.history.averageIntervalMs === null ? '' : String(Math.round(d.history.averageIntervalMs)),
      d.history.latestPullUTC ?? '',
      d.history.elapsedMs === null ? '' : String(d.history.elapsedMs), d.action,
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
  poolSize: number;
  rejectedRecords?: Record<PullRejectReason, number>;
}

export function buildHoldPlan(input: {
  decisions: HoldDecision[];
  dryRun: boolean;
  callerUid: string;
  asOfMs: number;
  digest: DigestFn;
  rejectedRecords?: Record<PullRejectReason, number>;
}): HoldPlan {
  const { decisions, dryRun, callerUid, asOfMs, digest, rejectedRecords } = input;
  const counts: Record<HoldAction, number> = {
    apply_hold: 0, skip_within_average: 0, skip_physically_down: 0, skip_already_held: 0,
    insufficient_history: 0, refuse_missing_status: 0, refuse_missing_bottom: 0,
    refuse_ambiguous_identity: 0,
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
    poolSize: decisions.length,
    ...(rejectedRecords ? { rejectedRecords } : {}),
  };
}

// ── atomic all-or-nothing commit ────────────────────────────────────────────

export interface HoldBatchEntry {
  wellKey: string;
  expectedFingerprint: string;
  record: EstimationHoldRecord;
}

export type HoldBatchOutcome =
  | { committed: true; root: Record<string, EstimationHoldRecord> }
  | { committed: false; conflicts: string[] };

/**
 * Verify EVERY expected fingerprint and write the whole set, or write nothing.
 *
 * Run as one RTDB transaction over the `emergencyHolds` root, so there is no
 * per-well window and no compensation pass. A compensating rollback can itself
 * abort under concurrent drift, which is how a batch ends up partially applied
 * while the error claims nothing was — this design cannot reach that state,
 * because a single conflict aborts before anything is written.
 */
export function holdBatchCompareAndSet(
  currentRoot: Record<string, unknown> | null | undefined,
  entries: HoldBatchEntry[],
): HoldBatchOutcome {
  const root = (currentRoot && typeof currentRoot === 'object' ? { ...currentRoot } : {}) as
    Record<string, EstimationHoldRecord>;
  const conflicts: string[] = [];
  for (const e of entries) {
    // No `?? null` here: an absent key and a key holding null are different
    // facts, and collapsing them would let one pass as the other.
    if (holdFingerprint(root[e.wellKey]) !== e.expectedFingerprint) conflicts.push(e.wellKey);
  }
  if (conflicts.length > 0) return { committed: false, conflicts };
  for (const e of entries) root[e.wellKey] = e.record;
  return { committed: true, root };
}
