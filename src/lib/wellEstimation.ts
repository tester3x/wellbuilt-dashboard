/**
 * Pure well-level estimation.
 *
 * Deliberately imports NOTHING. Every function here is a pure function of its
 * arguments plus an explicit `nowMs`, so the Well Status behaviour can be
 * tested with `node --test` without Firebase, a bundler, or a browser.
 *
 * The screen shows a LIVE estimate, not the level recorded at the last pull.
 * A tank keeps filling after the driver leaves, so between pulls the displayed
 * level is the last pull's bottom level plus what has accumulated since, at the
 * well's average flow rate. Only a new pull resets that baseline.
 */

export interface EstimationConfig {
  route?: string;
  routeColor?: string;
  maxLevel?: number;
  bottomLevel?: number;
  allowedBottom?: number;
  tanks?: number;
  numTanks?: number;
  pullBbls?: number;
  bblPerFoot?: number;
  avgFlowRate?: string;
  avgFlowRateMinutes?: number;
  ndicName?: string;
  companyId?: string;
}

export interface EstimationStatus {
  wellName?: string;
  currentLevel?: string;
  flowRate?: string;
  timeTillPull?: string;
  timestamp?: string;
  timestampUTC?: string;
  wellDown?: boolean;
  isDown?: boolean;
  responseId?: string;
  lastPullDateTime?: string;
  lastPullDateTimeUTC?: string;
  lastPullBbls?: string;
  lastPullTopLevel?: string;
  lastPullBottomLevel?: string;
  nextPullTime?: string;
  nextPullTimeUTC?: string;
  bbls24hrs?: string;
  windowBblsDay?: string;
  overnightBblsDay?: string;
  /** Server-owned emergency hold, projected by adminGetWellPool. */
  estimationHoldActive?: boolean;
  /** The pull the hold was taken against — the binding that makes it safe. */
  estimationHeldAtPullUTC?: string;
  [k: string]: unknown;
}

/** Why a row is not showing a live estimate. `live` means it is. */
export type EstimationBasis =
  | 'live'             // estimated forward from the last pull
  | 'well_down'        // wellDown — the level is not rising; show the recorded value
  | 'emergency_hold'   // server-side hold: freeze at the last accepted bottom level
  | 'no_pull'          // no pull on record for this well
  | 'no_flow_rate'     // avgFlowRateMinutes missing or <= 0
  | 'unparsable';      // bottom level or pull timestamp could not be read

/**
 * Is an emergency estimation hold in force for this row?
 *
 * The hold names the pull it was taken against. It is honoured only while that
 * is still the row's latest pull, so the moment a real pull lands the hold stops
 * applying on its own — no write, no ordering assumption, and no window where a
 * freshly pulled well stays frozen.
 */
export function estimationHoldApplies(status: EstimationStatus): boolean {
  if (status.estimationHoldActive !== true) return false;
  const heldAt = status.estimationHeldAtPullUTC;
  if (typeof heldAt !== 'string' || !heldAt) return false;
  return heldAt === status.lastPullDateTimeUTC;
}

/** Freshness of the authoritative snapshot the estimate is built on. */
export interface WellPoolHealth {
  /** True when the last authoritative refresh failed — the UI must say so. */
  degraded: boolean;
  /** Epoch ms of the last SUCCESSFUL authoritative load, or null if never. */
  lastAuthoritativeAt: number | null;
  /** Age of that snapshot in ms, or null if never loaded. */
  staleForMs: number | null;
  /** Stable code for the most recent failure, or null when healthy. */
  errorCode: string | null;
  /** True once an authoritative snapshot has been loaded at least once. */
  hasData: boolean;
}

// ── formatting ──────────────────────────────────────────────────────────────

/** Parse `X'Y"` to total inches. Returns 0 when it does not match. */
export function parseFeetInchesStr(str: string | undefined | null): number {
  if (!str) return 0;
  const match = String(str).match(/(\d+)'(\d+)"/);
  if (match) return parseInt(match[1], 10) * 12 + parseInt(match[2], 10);
  return 0;
}

/** Format total inches as `X'Y"`. */
export function inchesToDisplay(totalInches: number): string {
  const feet = Math.floor(totalInches / 12);
  const inches = Math.floor(totalInches % 12);
  return `${feet}'${inches}"`;
}

// ── estimation ──────────────────────────────────────────────────────────────

/**
 * Level in inches at `nowMs`, given the level right after the last pull.
 *
 * Returns null when the inputs cannot support an estimate, so the caller can
 * fall back to the recorded value rather than display a fabricated one.
 */
export function estimateCurrentLevel(
  bottomInches: number,
  lastPullTimeUTC: string | undefined | null,
  flowRateMinutes: number,
  nowMs: number,
): number | null {
  if (!lastPullTimeUTC || flowRateMinutes <= 0 || bottomInches <= 0) return null;
  const lastPullTime = new Date(lastPullTimeUTC).getTime();
  if (!Number.isFinite(lastPullTime) || lastPullTime <= 0) return null;
  // A pull timestamped in the future would run the estimate backwards.
  const minutesElapsed = Math.max(0, (nowMs - lastPullTime) / (1000 * 60));
  const minutesPerInch = flowRateMinutes / 12;
  return bottomInches + minutesElapsed / minutesPerInch;
}

/** Time from `currentInches` up to `targetInches` at the given flow rate. */
export function calcTimeTillPull(
  currentInches: number,
  targetInches: number,
  flowRateMinutes: number,
): string {
  if (flowRateMinutes <= 0) return 'Unknown';
  const inchesNeeded = targetInches - currentInches;
  if (inchesNeeded <= 0) return 'Ready';
  const totalMinutes = inchesNeeded * (flowRateMinutes / 12);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = Math.floor(totalMinutes % 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Target height (inches) at which this well holds a full pull. */
export function calcTankAtLevel(
  tanks: number,
  pullBbls: number,
  bottomInches: number,
  bblPerFootPerTank: number = 20,
): { tankAtInches: number; tankAtLevel: string } {
  const bblsPerTank = pullBbls / tanks;
  const tankAtInches = ((bblsPerTank / bblPerFootPerTank) * 12) + bottomInches;
  const tankAtFeet = Math.floor(tankAtInches / 12);
  const tankAtRemainder = Math.round(tankAtInches - tankAtFeet * 12);
  return { tankAtInches, tankAtLevel: `${tanks} @ ${tankAtFeet}'${tankAtRemainder}"` };
}

// ── row assembly ────────────────────────────────────────────────────────────

export interface EstimatedWellRow {
  wellName: string;
  currentLevel: string;
  currentLevelInches?: number;
  etaToMax: string;
  timeTillPull: string;
  flowRate: string;
  timestamp: string;
  timestampUTC?: string;
  route: string;
  tanks: number;
  tankAtLevel: string;
  pullBbls: number;
  bottomLevel: number;
  isDown: boolean;
  wellDown?: boolean;
  ndicName: string;
  bblPerFoot?: number;
  responseId?: string;
  lastPullDateTime?: string;
  lastPullDateTimeUTC?: string;
  lastPullBbls?: string;
  lastPullTopLevel?: string;
  lastPullBottomLevel?: string;
  nextPullTime?: string;
  nextPullTimeUTC?: string;
  bbls24hrs?: string;
  windowBblsDay?: string;
  overnightBblsDay?: string;
  status?: string;
  /** Why this row is or is not a live estimate — drives the UI badge. */
  estimationBasis: EstimationBasis;
}

/**
 * Build the displayed rows from an authoritative snapshot.
 *
 * `wellConfig` is the master list: a well with no pull still appears, so the
 * screen never silently drops a well. `wellStatus` is keyed by well name and
 * holds the LATEST pull the server projected for it — replacing that entry is
 * what resets an estimate onto a new baseline, which is why a new pull needs no
 * page reload and no special-casing here.
 */
export function buildWellRows(input: {
  wellConfig: Record<string, EstimationConfig>;
  wellStatus: Record<string, EstimationStatus>;
  nowMs: number;
}): EstimatedWellRow[] {
  const { wellConfig, wellStatus, nowMs } = input;
  const rows: EstimatedWellRow[] = [];

  for (const [wellName, rawConfig] of Object.entries(wellConfig || {})) {
    const config = (rawConfig || {}) as EstimationConfig;
    const tanks = config.tanks || config.numTanks || 1;
    const pullBbls = config.pullBbls || 140;
    const bottomLevelFeet = config.bottomLevel ?? config.allowedBottom ?? 3;
    const bottomInches = bottomLevelFeet * 12;
    const bblPerFootPerTank = config.bblPerFoot ? config.bblPerFoot / tanks : 20;
    const { tankAtInches, tankAtLevel } = calcTankAtLevel(
      tanks, pullBbls, bottomInches, bblPerFootPerTank,
    );

    // Status is keyed by well name. Tolerate the space-stripped key so a
    // config/status naming mismatch cannot blank a well.
    const status: EstimationStatus =
      (wellStatus && (wellStatus[wellName] || wellStatus[wellName.replace(/\s/g, '')])) || {};
    const hasPull = Object.keys(status).length > 0;

    const isDown = status.wellDown === true || status.isDown === true;
    const afrMinutes = typeof config.avgFlowRateMinutes === 'number' ? config.avgFlowRateMinutes : 0;

    let currentLevel = (status.currentLevel as string) || '--';
    let timeTillPull = (status.timeTillPull as string) || 'Unknown';
    let currentLevelInches: number | undefined;
    let basis: EstimationBasis;

    if (!hasPull) {
      basis = 'no_pull';
    } else if (isDown) {
      // A down well is not filling. Show what was recorded, never a forecast.
      basis = 'well_down';
      timeTillPull = 'Down';
    } else if (estimationHoldApplies(status)) {
      // Held: the last pull is still correct, but no newer one can arrive, so
      // projecting forward would invent barrels. Freeze at the level the driver
      // actually left behind. lastPullDateTimeUTC and the flow rate are
      // untouched, so the moment a real pull lands this resumes on its own.
      basis = 'emergency_hold';
      currentLevel = (status.lastPullBottomLevel as string) || currentLevel;
      timeTillPull = 'Held';
    } else if (afrMinutes <= 0) {
      basis = 'no_flow_rate';
    } else {
      const pullBottomInches = parseFeetInchesStr(status.lastPullBottomLevel as string);
      const estInches = estimateCurrentLevel(
        pullBottomInches, status.lastPullDateTimeUTC as string, afrMinutes, nowMs,
      );
      if (estInches === null) {
        basis = 'unparsable';
      } else {
        basis = 'live';
        currentLevelInches = estInches;
        currentLevel = inchesToDisplay(estInches);
        timeTillPull = calcTimeTillPull(estInches, tankAtInches, afrMinutes);
      }
    }

    if (currentLevelInches === undefined && currentLevel !== '--') {
      currentLevelInches = parseFeetInchesStr(currentLevel);
    }

    rows.push({
      ...(status as Record<string, unknown>),
      wellName,
      currentLevel,
      currentLevelInches,
      timeTillPull,
      etaToMax: timeTillPull,
      flowRate: config.avgFlowRate || (status.flowRate as string) || 'Unknown',
      timestamp: (status.timestamp as string) || '',
      timestampUTC: (status.lastPullDateTimeUTC as string) || (status.timestampUTC as string),
      route: config.route || 'Unrouted',
      tanks,
      tankAtLevel,
      pullBbls,
      bottomLevel: bottomLevelFeet,
      isDown,
      ndicName: config.ndicName || '',
      bblPerFoot: config.bblPerFoot,
      estimationBasis: basis,
    } as EstimatedWellRow);
  }

  return rows.sort((a, b) => a.wellName.localeCompare(b.wellName));
}

/** Route list for the row set. "Unrouted" always sorts last. */
export function routesFromRows(rows: { route?: string }[]): string[] {
  return Array.from(new Set(rows.map((r) => r.route).filter((r): r is string => !!r)))
    .sort((a, b) => {
      if (a === 'Unrouted') return 1;
      if (b === 'Unrouted') return -1;
      return a.localeCompare(b);
    });
}

/** Health for a snapshot, given the last success and the current failure. */
export function computeHealth(input: {
  lastAuthoritativeAt: number | null;
  errorCode: string | null;
  nowMs: number;
}): WellPoolHealth {
  const { lastAuthoritativeAt, errorCode, nowMs } = input;
  return {
    degraded: errorCode !== null,
    lastAuthoritativeAt,
    staleForMs: lastAuthoritativeAt === null ? null : Math.max(0, nowMs - lastAuthoritativeAt),
    errorCode,
    hasData: lastAuthoritativeAt !== null,
  };
}

export interface PoolHealthNotice {
  severity: 'warning' | 'error';
  title: string;
  detail: string;
}

/** How long a healthy snapshot may age before the screen admits it is stale. */
export const STALE_AFTER_MS = 3 * 60 * 1000;

/**
 * The user-facing freshness notice, or null when the pool is genuinely current.
 *
 * Returns a notice in three cases: the refresh is failing, nothing has ever
 * loaded, or the last good snapshot has aged past STALE_AFTER_MS (which catches
 * a refresh that silently stopped without throwing).
 *
 * Reads the age off `health` rather than the clock, so this stays pure and can
 * be called during render. `staleForMs` is stamped every time the subscription
 * publishes — the same 30s tick that moves the levels — so the banner and the
 * numbers beside it are always describing the same moment.
 */
export function describePoolHealth(
  health: WellPoolHealth | null | undefined,
): PoolHealthNotice | null {
  if (!health) return null;

  if (!health.hasData) {
    return health.degraded
      ? {
          severity: 'error',
          title: 'Well data unavailable',
          detail: `Could not load well status (${health.errorCode ?? 'unknown'}). Levels are not shown.`,
        }
      : null; // first load still in flight — not an error yet
  }

  const ageMs = health.staleForMs;

  if (health.degraded) {
    return {
      severity: 'error',
      title: 'Not updating — showing estimates',
      detail:
        `Last confirmed ${formatAge(ageMs)} ago (${health.errorCode ?? 'unknown'}). ` +
        'Levels are estimated from that snapshot and may miss recent pulls.',
    };
  }

  if (ageMs !== null && ageMs >= STALE_AFTER_MS) {
    return {
      severity: 'warning',
      title: 'Data may be stale',
      detail: `Last confirmed ${formatAge(ageMs)} ago.`,
    };
  }

  return null;
}

/** Compact age for the banner: "45s", "6m", "2h". */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'never';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ── subscription orchestration ──────────────────────────────────────────────

export const AUTHORITATIVE_REFRESH_MS = 60 * 1000;
export const ESTIMATE_TICK_MS = 30 * 1000;

export interface WellPoolSnapshot {
  wellConfig: Record<string, EstimationConfig>;
  wellStatus: Record<string, EstimationStatus>;
}

export interface WellPoolSubscriptionDeps {
  /** Authoritative, server-authorised snapshot load. */
  loadPool: () => Promise<Partial<WellPoolSnapshot>>;
  /** Receives freshly estimated rows. Never called after unsubscribe. */
  emit: (rows: EstimatedWellRow[], routes: string[], health: WellPoolHealth) => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onError?: (err: unknown) => void;
  authoritativeMs?: number;
  estimateMs?: number;
}

/**
 * Drive the Well Status screen from an authoritative snapshot.
 *
 * Every side effect is injected, so the whole lifecycle — timers, ordering,
 * teardown — is testable without Firebase, a bundler, or real time.
 *
 * Two clocks on purpose. `authoritativeMs` re-loads the snapshot so a newly
 * processed pull lands and rebaselines that well without a page reload;
 * `estimateMs` recomputes levels from the snapshot already held, which costs
 * nothing and keeps the display moving even while a refresh is failing.
 *
 * Returns the unsubscribe function.
 */
export function createWellPoolSubscription(deps: WellPoolSubscriptionDeps): () => void {
  const {
    loadPool, emit, now, setTimer, clearTimer, onError,
    authoritativeMs = AUTHORITATIVE_REFRESH_MS,
    estimateMs = ESTIMATE_TICK_MS,
  } = deps;

  let stopped = false;
  let inFlight = false;
  let wellConfig: Record<string, EstimationConfig> = {};
  let wellStatus: Record<string, EstimationStatus> = {};
  let lastAuthoritativeAt: number | null = null;
  let errorCode: string | null = null;

  const publish = () => {
    if (stopped) return;
    const nowMs = now();
    const rows = buildWellRows({ wellConfig, wellStatus, nowMs });
    emit(rows, routesFromRows(rows), computeHealth({ lastAuthoritativeAt, errorCode, nowMs }));
  };

  const refresh = async () => {
    // `inFlight` is what makes snapshots un-reorderable: a second load cannot
    // start while one is outstanding, so two responses can never race to
    // overwrite each other. It also caps the callable at one call in flight per
    // subscription no matter how the timers drift.
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const pool = await loadPool();
      // Re-checked after the await — unsubscribe can happen mid-flight. This
      // only avoids writing state nobody will read; `publish` refuses to emit
      // once stopped, so the guarantee the caller sees comes from there.
      if (stopped) return;
      wellConfig = (pool?.wellConfig || {}) as Record<string, EstimationConfig>;
      wellStatus = (pool?.wellStatus || {}) as Record<string, EstimationStatus>;
      lastAuthoritativeAt = now();
      errorCode = null;
    } catch (err) {
      if (stopped) return;
      // Keep the last good snapshot — estimating from it is still useful — but
      // record the failure so the screen can say the data is unconfirmed.
      errorCode = errorCodeOf(err);
      onError?.(err);
    } finally {
      inFlight = false;
      publish();
    }
  };

  void refresh();
  const refreshHandle = setTimer(() => { void refresh(); }, authoritativeMs);
  const estimateHandle = setTimer(publish, estimateMs);

  return () => {
    stopped = true;
    clearTimer(refreshHandle);
    clearTimer(estimateHandle);
  };
}

/** Stable code for a thrown value, for display and tests. */
export function errorCodeOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'unknown';
}
