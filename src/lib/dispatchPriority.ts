/**
 * Firebase-free PW-queue priority + prediction helpers for the Dispatch board.
 *
 * Extracted from app/dispatch/page.tsx so the priority buckets and the
 * time-till-pull (TTP) display can be unit-tested and kept consistent.
 *
 * IMPORTANT (TTP consistency fix): the priority badge is computed LIVE from
 * `nextPullTimeUTC` vs the current time, but the dispatch row previously showed
 * the raw server-snapshot `well.timeTillPull` string, which is frozen at
 * pull-processing time. Between pulls the badge would read OVERDUE while the TTP
 * column still showed a stale positive value. `formatTTP` derives the TTP text
 * from the SAME live calculation as the badge so they never contradict.
 *
 * `nowMs` is injectable for deterministic tests; it defaults to Date.now().
 */
import type { WellResponse } from './wells';
import {
  formatFeetWBM,
  estimateCurrentFeet,
  readyLevelFeet,
  availableLoadsAt,
  predictedReadyAtMs,
  WBM_DEFAULT_LOAD_BBLS,
  type EstimatorInputs,
} from './wbmLevelEstimator.ts';
import { wbmInputsFromWell } from './wellLevelProjection.ts';

export type PriorityLevel = 'overdue' | 'soon' | 'today' | 'later' | 'unknown';

export interface PriorityInfo {
  level: PriorityLevel;
  label: string;
  color: string;
  textColor: string;
  sortOrder: number;
  hoursUntilPull: number | null;
}

export function getPriority(well: WellResponse, nowMs: number = Date.now()): PriorityInfo {
  const isDown = well.isDown || well.currentLevel === 'DOWN';
  if (isDown) {
    return { level: 'unknown', label: 'DOWN', color: 'bg-gray-600', textColor: 'text-gray-300', sortOrder: 999, hoursUntilPull: null };
  }

  // Try nextPullTimeUTC first (most accurate — an absolute time that stays live)
  if (well.nextPullTimeUTC) {
    const pullTime = new Date(well.nextPullTimeUTC).getTime();
    if (!isNaN(pullTime)) {
      const hoursUntil = (pullTime - nowMs) / (1000 * 60 * 60);

      if (hoursUntil <= 0) {
        return { level: 'overdue', label: 'OVERDUE', color: 'bg-red-600', textColor: 'text-white', sortOrder: 1, hoursUntilPull: hoursUntil };
      }
      if (hoursUntil <= 6) {
        return { level: 'soon', label: `${Math.round(hoursUntil)}h`, color: 'bg-orange-600', textColor: 'text-white', sortOrder: 2, hoursUntilPull: hoursUntil };
      }
      if (hoursUntil <= 24) {
        return { level: 'today', label: `${Math.round(hoursUntil)}h`, color: 'bg-yellow-600', textColor: 'text-white', sortOrder: 3, hoursUntilPull: hoursUntil };
      }
      const days = Math.floor(hoursUntil / 24);
      return { level: 'later', label: `${days}d+`, color: 'bg-green-700', textColor: 'text-white', sortOrder: 4, hoursUntilPull: hoursUntil };
    }
  }

  // Fallback: parse timeTillPull string
  const ttp = well.timeTillPull || well.etaToMax || '';
  if (ttp === 'Ready') {
    return { level: 'overdue', label: 'READY', color: 'bg-red-600', textColor: 'text-white', sortOrder: 1, hoursUntilPull: 0 };
  }

  // Parse "Xd Yh Zm" or "Yh Zm" format
  const dayMatch = ttp.match(/(\d+)d/);
  const hourMatch = ttp.match(/(\d+)h/);
  const minMatch = ttp.match(/(\d+)m/);
  let totalHours = 0;
  if (dayMatch) totalHours += parseInt(dayMatch[1]) * 24;
  if (hourMatch) totalHours += parseInt(hourMatch[1]);
  if (minMatch) totalHours += parseInt(minMatch[1]) / 60;

  if (totalHours > 0) {
    if (totalHours <= 6) {
      return { level: 'soon', label: `${Math.round(totalHours)}h`, color: 'bg-orange-600', textColor: 'text-white', sortOrder: 2, hoursUntilPull: totalHours };
    }
    if (totalHours <= 24) {
      return { level: 'today', label: `${Math.round(totalHours)}h`, color: 'bg-yellow-600', textColor: 'text-white', sortOrder: 3, hoursUntilPull: totalHours };
    }
    const days = Math.floor(totalHours / 24);
    return { level: 'later', label: `${days}d+`, color: 'bg-green-700', textColor: 'text-white', sortOrder: 4, hoursUntilPull: totalHours };
  }

  return { level: 'unknown', label: '--', color: 'bg-gray-600', textColor: 'text-gray-300', sortOrder: 5, hoursUntilPull: null };
}

/**
 * TTP column text — consistent with (and as live as) the priority badge.
 * When a live time is available it formats the live remaining hours; otherwise
 * it falls back to the server snapshot string (same staleness as before, never
 * worse) or '--'.
 */
/**
 * TTP text — HEIGHT-FIRST. Never an elapsed deadline. TTP is only shown when the
 * well is APPROACHING with validated positive flow; otherwise the honest state.
 */
export function formatTTP(well: WellResponse, nowMs: number = Date.now()): string {
  const c = classifyWell(well, nowMs);
  switch (c.state) {
    case 'pull-now': return 'PULL NOW';
    case 'approaching': {
      // Time until the deterministic predictedReadyAt (absolute), not an elapsed deadline.
      const h = c.ttpHours;
      if (h === null) return 'rising';
      if (h <= 0) return 'PULL NOW';
      if (h < 24) return `${Math.round(h)}h`;
      const d = Math.floor(h / 24); const r = Math.round(h % 24); return r > 0 ? `${d}d ${r}h` : `${d}d`;
    }
    case 'no-gain': return 'NO FLOW';
    case 'verify': return 'NEEDS DATA';
    case 'assigned': return 'ASSIGNED';
    case 'down': return 'DOWN';
    default: return '--';
  }
}

// ─── Prediction Model ────────────────────────────────────────────────────────

export interface WellPrediction {
  pullsPerDay: number | null;
  hoursPerPull: number | null;
  driverLoad: 'low' | 'normal' | 'high' | 'critical' | null;
  warning: string | null;
}

export function getWellPrediction(well: WellResponse): WellPrediction {
  const isDown = well.isDown || well.currentLevel === 'DOWN';
  if (isDown) return { pullsPerDay: null, hoursPerPull: null, driverLoad: null, warning: null };

  const bblsDayStr = well.windowBblsDay || well.bbls24hrs || '';
  const bblsDay = parseFloat(bblsDayStr);
  if (!bblsDay || bblsDay <= 0) return { pullsPerDay: null, hoursPerPull: null, driverLoad: null, warning: null };

  const pullBbls = well.pullBbls || 140;
  const pullsPerDay = bblsDay / pullBbls;
  const hoursPerPull = 24 / pullsPerDay;

  let driverLoad: WellPrediction['driverLoad'] = 'low';
  let warning: string | null = null;

  if (pullsPerDay >= 3) {
    driverLoad = 'critical';
    warning = `${pullsPerDay.toFixed(1)} pulls/day — dedicated driver needed`;
  } else if (pullsPerDay >= 2) {
    driverLoad = 'high';
    warning = `${pullsPerDay.toFixed(1)} pulls/day — multiple visits required`;
  } else if (pullsPerDay >= 1.2) {
    driverLoad = 'normal';
    warning = null;
  } else {
    driverLoad = 'low';
    warning = null;
  }

  return { pullsPerDay, hoursPerPull, driverLoad, warning };
}

export function formatNextPull(well: WellResponse): string {
  if (!well.nextPullTime && !well.nextPullTimeUTC) return '--';
  try {
    const dateStr = well.nextPullTimeUTC || well.nextPullTime || '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return well.nextPullTime || '--';
    return date.toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return well.nextPullTime || '--';
  }
}


// ===========================================================================
// HEIGHT-FIRST classification (Mike's governing rule)
//
// A well is pullable because its TRUSTWORTHY level has reached its configured
// pull-height target -- NOT because time elapsed. Time is only an input to a
// BOUNDED height estimate, and only while a positive-gain model remains valid.
// The absence of wellDown=true is NOT evidence of active flow. "OVERDUE" is
// never used for an unassigned prediction.
// ===========================================================================

/** A level reading older than this (without other evidence) is untrusted -> VERIFY. */
export const TRUST_WINDOW_HOURS = 48;

export type WellState = 'pull-now' | 'approaching' | 'no-gain' | 'verify' | 'assigned' | 'down';
export type QueueView = 'needs-pull' | 'next-24h' | 'all' | 'needs-data';

export interface WellClassification {
  state: WellState;
  label: string;
  color: string;
  textColor: string;
  sortOrder: number;
  targetInches: number | null;
  lastLevel: string | null;
  lastLevelInches: number | null;
  lastLevelAgeHours: number | null;
  estInches: number | null;
  remainingInches: number | null;
  ttpHours: number | null;
  gainValid: boolean;
  fresh: boolean;
  /** For verify/no-gain: why it is not actionable. missing_baseline | missing_timestamp | missing_target | no_flow_data */
  reason?: string;
  // ── WB‑M vc58 live-level parity fields (the single shared estimate) ──
  /** Estimated current level in decimal feet at the shared asOfMs (capped 20). */
  estFeet: number | null;
  /** WB‑M-formatted display of estFeet ("7'", "7'6\"", "20'", or "--"). */
  estDisplay: string;
  /** Pull-ready target = allowedBottom + loadBbls/bblsPerFoot (decimal feet). */
  readyFeet: number | null;
  /** Absolute predicted ready time (ms); may be in the past ("ready now"). */
  predictedReadyAtMs: number | null;
  /** True only when a positive flow is driving a live rise (not frozen/down). */
  hasFlow: boolean;
  /** Loads currently available at the estimate (WB‑M floor((est-bottom)*bbl/ft / load)). */
  availableLoads: number;
}

/** Parse a feet/inches level string to inches. Handles 1'3", 7'6", 15, 15". */
export function parseLevelInches(str: string | null | undefined): number | null {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (!s || s === '--' || s.toUpperCase() === 'DOWN') return null;
  const fi = s.match(/(\d+)\s*'\s*(\d+)?/);
  if (fi) return parseInt(fi[1], 10) * 12 + (fi[2] ? parseInt(fi[2], 10) : 0);
  const n = parseFloat(s.replace(/["]/g, ''));
  return isNaN(n) ? null : n;
}

export interface ClassifyOpts { assigned?: boolean; }

/**
 * WB‑M vc58 live-level parity classifier. The estimated current level is the
 * SINGLE source of truth for the badge, the "Current Level (Est.)" column, the
 * view filters, TTP, counts, and sorting — computed at one shared `nowMs`
 * (asOfMs) so every surface agrees. NO 48h freshness rejection: a valid forecast
 * basis stays actionable regardless of age (it just estimates and caps at 20').
 */
export function classifyWell(well: WellResponse, nowMs: number = Date.now(), opts: ClassifyOpts = {}): WellClassification {
  // Level inputs come from the ONE shared resolver so Dispatch, the aggregate
  // Well Status page, and the individual card all estimate identically.
  const { startingBottomFeet, pullTimeMs, flowMinutesPerFoot, wellDown } = wbmInputsFromWell(well);
  const allowedBottomFeet = typeof well.bottomLevel === 'number' ? well.bottomLevel : null;
  // WB‑M loadBbls = the driver's local load size (default 140), NOT config.pullBbls
  // (see wbmLevelEstimator.WBM_DEFAULT_LOAD_BBLS). The Dashboard has no per-driver
  // value, so it uses the WB‑M default for a driver-agnostic parity threshold.
  const loadBbls = WBM_DEFAULT_LOAD_BBLS;
  // bblsPerFoot = configured effective bbl/ft, else WB‑M's proven fallback 20×numTanks
  // (getBblPerFootSync, wellConfig.ts:397/410). If tanks is absent too → undeterminable
  // capacity → target unavailable (do NOT invent a tank count).
  const bblsPerFoot = (typeof well.bblPerFoot === 'number' && well.bblPerFoot > 0)
    ? well.bblPerFoot
    : (typeof well.tanks === 'number' && well.tanks > 0 ? 20 * well.tanks : null);
  const readyFeet = readyLevelFeet({ allowedBottomFeet, loadBbls, bblsPerFoot });

  const inputs: EstimatorInputs = { startingBottomFeet, pullTimeMs, flowMinutesPerFoot, wellDown };
  const est = estimateCurrentFeet(inputs, nowMs);
  const readyAt = predictedReadyAtMs(inputs, readyFeet);
  const availableLoads = availableLoadsAt({ estFeet: est.feet, allowedBottomFeet, loadBbls, bblsPerFoot });
  const ageHours = pullTimeMs != null ? (nowMs - pullTimeMs) / 3600000 : null;

  const common = {
    targetInches: readyFeet != null ? readyFeet * 12 : null,
    lastLevel: (well.currentLevel && well.currentLevel !== '--') ? well.currentLevel : (well.lastPullBottomLevel || null),
    lastLevelInches: startingBottomFeet != null ? startingBottomFeet * 12 : null,
    lastLevelAgeHours: ageHours,
    estInches: est.feet != null ? est.feet * 12 : null,
    remainingInches: (readyFeet != null && est.feet != null) ? Math.max(0, (readyFeet - est.feet) * 12) : null,
    ttpHours: readyAt != null ? (readyAt - nowMs) / 3600000 : null,
    gainValid: est.hasFlow,
    fresh: pullTimeMs != null,
    estFeet: est.feet,
    estDisplay: formatFeetWBM(est.feet),
    readyFeet,
    predictedReadyAtMs: readyAt,
    hasFlow: est.hasFlow,
    availableLoads,
  };
  const make = (c: Partial<WellClassification>): WellClassification => ({
    ...common, state: 'verify', label: 'VERIFY', color: 'bg-amber-600', textColor: 'text-white', sortOrder: 50, ...c,
  } as WellClassification);

  // 1. Well Down — freeze at baseline, remain DOWN.
  if (wellDown) return make({ state: 'down', label: 'DOWN', color: 'bg-gray-600', textColor: 'text-gray-300', sortOrder: 90 });
  // 2. Already assigned to a driver.
  if (opts.assigned) return make({ state: 'assigned', label: 'ASSIGNED', color: 'bg-slate-600', textColor: 'text-white', sortOrder: 80 });
  // 3. Genuinely unavailable — never substitute zero.
  if (startingBottomFeet == null) return make({ state: 'verify', label: 'NEEDS DATA', color: 'bg-amber-600', textColor: 'text-white', sortOrder: 55, reason: 'missing_baseline' });
  if (pullTimeMs == null) return make({ state: 'verify', label: 'NEEDS DATA', color: 'bg-amber-600', textColor: 'text-white', sortOrder: 55, reason: 'missing_timestamp', estFeet: null, estDisplay: '--', estInches: null });
  if (readyFeet == null) return make({ state: 'verify', label: 'NEEDS DATA', color: 'bg-amber-600', textColor: 'text-white', sortOrder: 55, reason: 'missing_target' });

  // 4. Estimated current level at/above the pull-ready target → PULL NOW.
  if (est.feet != null && est.feet >= readyFeet) {
    return make({ state: 'pull-now', label: 'PULL NOW', color: 'bg-red-600', textColor: 'text-white', sortOrder: 1 });
  }
  // 5. Rising with valid flow → APPROACHING with a deterministic ready time.
  if (est.hasFlow) {
    return make({ state: 'approaching', label: 'APPROACHING', color: 'bg-yellow-600', textColor: 'text-black', sortOrder: 2 });
  }
  // 6. No flow data — freeze; below target and cannot forecast (no fake urgency).
  return make({ state: 'no-gain', label: 'NO FLOW', color: 'bg-gray-500', textColor: 'text-white', sortOrder: 40, reason: 'no_flow_data' });
}

/** Human-readable explanation for a verify/no-flow classification reason code. */
export function verifyReasonText(reason: string | undefined): string {
  switch (reason) {
    case 'missing_baseline': return 'no last-pull bottom level or reading available';
    case 'missing_timestamp': return 'no valid pull/observation timestamp';
    case 'missing_target': return 'no configured pull-ready target (bottom / load / bbl-per-ft)';
    case 'no_flow_data': return 'no flow data — level frozen at last reading';
    default: return 'no pull prediction available';
  }
}

export function matchesView(well: WellResponse, view: QueueView, nowMs: number = Date.now(), opts: ClassifyOpts = {}): boolean {
  const c = classifyWell(well, nowMs, opts);
  if (c.state === 'down') return false;
  switch (view) {
    case 'needs-pull': return c.state === 'pull-now';
    case 'next-24h': return c.state === 'approaching' && c.ttpHours !== null && c.ttpHours <= 24;
    case 'needs-data': return c.state === 'verify' || c.state === 'no-gain';
    case 'all': return true;
  }
}

export type QueueBucket = 'needs-pull' | 'next-24h' | 'later' | 'needs-data' | 'down' | 'assigned';

/** The one canonical bucket a well belongs to (derived from classifyWell). */
export function wellBucket(well: WellResponse, nowMs: number = Date.now(), opts: ClassifyOpts = {}): QueueBucket {
  const c = classifyWell(well, nowMs, opts);
  switch (c.state) {
    case 'pull-now': return 'needs-pull';
    case 'approaching': return c.ttpHours !== null && c.ttpHours <= 24 ? 'next-24h' : 'later';
    case 'no-gain':
    case 'verify': return 'needs-data';
    case 'assigned': return 'assigned';
    case 'down': return 'down';
  }
}

export function hasValidPrediction(well: WellResponse, nowMs: number = Date.now()): boolean {
  const s = classifyWell(well, nowMs).state;
  return s === 'pull-now' || s === 'approaching';
}

export function formatAge(hours: number | null): string {
  if (hours === null || isNaN(hours)) return '';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function inchesToLevel(inches: number | null): string {
  if (inches === null || isNaN(inches)) return '--';
  const ft = Math.floor(inches / 12);
  const inch = Math.round(inches - ft * 12);
  return `${ft}'${inch}"`;
}

export interface QueueRowItem {
  well: WellResponse;
  priority: WellClassification;
  assignment?: {
    state: 'assigned_not_started' | 'assigned_started';
    driver: string;
    job?: unknown;
    status?: string;
  } | null;
}

/**
 * Global queue sort comparator:
 * 1. Overdue / Needs Pull (Tier 1: pull-now, ascending predictedReadyAtMs)
 * 2. Approaching (Tier 2: approaching, ascending predictedReadyAtMs / TTP globally)
 * 3. Needs Data / No Flow (Tier 3: no-gain / verify)
 * 4. Down (Tier 4: down)
 *
 * Assignment is a secondary badge and does NOT demote an urgent well.
 * Stable alphabetical tiebreaker on wellName.
 */
export function compareQueueRows(a: QueueRowItem, b: QueueRowItem): number {
  const tier = (p: WellClassification) => {
    if (p.state === 'pull-now') return 1;
    if (p.state === 'approaching') return 2;
    if (p.state === 'no-gain' || p.state === 'verify') return 3;
    if (p.state === 'down') return 4;
    return 5;
  };
  const tierA = tier(a.priority);
  const tierB = tier(b.priority);
  if (tierA !== tierB) return tierA - tierB;

  if (tierA === 1 || tierA === 2) {
    const readyA = a.priority.predictedReadyAtMs ?? Number.POSITIVE_INFINITY;
    const readyB = b.priority.predictedReadyAtMs ?? Number.POSITIVE_INFINITY;
    if (readyA !== readyB) return readyA - readyB;
  }

  return (a.well.wellName || '').localeCompare(b.well.wellName || '');
}

export function sortQueueRows<T extends QueueRowItem>(items: T[]): T[] {
  return [...items].sort(compareQueueRows);
}
