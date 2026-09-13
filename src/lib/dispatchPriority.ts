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
    case 'approaching':
      if (c.ttpHours === null) return 'rising';
      if (c.ttpHours < 24) return `${Math.round(c.ttpHours)}h`;
      { const d = Math.floor(c.ttpHours / 24); const r = Math.round(c.ttpHours % 24); return r > 0 ? `${d}d ${r}h` : `${d}d`; }
    case 'no-gain': return 'NO GAIN';
    case 'verify': return 'VERIFY';
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

/** Configured pull-height target in inches (from tankAtLevel "N @ F'I""). */
export function targetInches(well: WellResponse): number | null {
  if (well.tankAtLevel && well.tankAtLevel.includes('@')) {
    return parseLevelInches(well.tankAtLevel.split('@')[1]);
  }
  return null;
}

function bblsPerDay(well: WellResponse): number {
  const v = parseFloat(well.windowBblsDay || well.bbls24hrs || well.overnightBblsDay || '');
  return isNaN(v) ? 0 : v;
}

/** Inches/hour of level gain from validated production (needs bbls/day + bbl/ft). */
function riseInchesPerHour(well: WellResponse): number | null {
  const bd = bblsPerDay(well);
  if (bd <= 0 || !well.bblPerFoot || well.bblPerFoot <= 0) return null;
  return (bd / 24) / well.bblPerFoot * 12;
}

export interface ClassifyOpts { assigned?: boolean; }

export function classifyWell(well: WellResponse, nowMs: number = Date.now(), opts: ClassifyOpts = {}): WellClassification {
  const base = {
    targetInches: null as number | null, lastLevel: null as string | null, lastLevelInches: null as number | null,
    lastLevelAgeHours: null as number | null, estInches: null as number | null, remainingInches: null as number | null,
    ttpHours: null as number | null, gainValid: false, fresh: false,
  };

  if (well.isDown || well.wellDown || well.currentLevel === 'DOWN') {
    return { ...base, state: 'down', label: 'DOWN', color: 'bg-gray-600', textColor: 'text-gray-300', sortOrder: 90 };
  }
  if (opts.assigned) {
    return { ...base, state: 'assigned', label: 'ASSIGNED', color: 'bg-slate-600', textColor: 'text-white', sortOrder: 80 };
  }

  const target = targetInches(well);
  const lastLevel = (well.currentLevel && well.currentLevel !== '--') ? well.currentLevel : null;
  const lastIn = (typeof well.currentLevelInches === 'number' ? well.currentLevelInches : parseLevelInches(lastLevel));
  const lastTsStr = well.timestampUTC || well.lastPullDateTimeUTC || '';
  const lastTs = lastTsStr ? new Date(lastTsStr).getTime() : NaN;
  const ageHours = !isNaN(lastTs) ? (nowMs - lastTs) / 3600000 : null;
  const gainValid = bblsPerDay(well) > 0;
  const fresh = ageHours !== null && ageHours >= 0 && ageHours <= TRUST_WINDOW_HOURS;

  const withCommon = (c: Partial<WellClassification>): WellClassification => ({
    ...base, targetInches: target, lastLevel, lastLevelInches: lastIn, lastLevelAgeHours: ageHours,
    gainValid, fresh, state: 'verify', label: 'VERIFY', color: 'bg-amber-600', textColor: 'text-white', sortOrder: 50, ...c,
  });

  if (target === null || lastIn === null) {
    return withCommon({ state: 'verify', label: 'NEEDS DATA', color: 'bg-amber-600', textColor: 'text-white', sortOrder: 55 });
  }

  // Reading too old to trust as current -- elapsed time never makes it pullable.
  // (Barbarian: 1'3", 136 days old -> VERIFY, never PULL/OVER.)
  if (!fresh) {
    return withCommon({ state: 'verify', label: 'VERIFY', color: 'bg-amber-600', textColor: 'text-white', sortOrder: 50 });
  }

  if (lastIn >= target) {
    return withCommon({ state: 'pull-now', label: 'PULL NOW', color: 'bg-red-600', textColor: 'text-white', sortOrder: 1, estInches: lastIn, remainingInches: 0 });
  }

  const remaining = target - lastIn;
  if (gainValid) {
    const rate = riseInchesPerHour(well);
    const ttpHours = rate ? remaining / rate : null;
    return withCommon({
      state: 'approaching', label: 'APPROACHING', color: 'bg-yellow-600', textColor: 'text-black', sortOrder: 2,
      estInches: lastIn, remainingInches: remaining, ttpHours,
    });
  }

  // Below target and NOT gaining -- not pullable regardless of Well-Down flag.
  return withCommon({ state: 'no-gain', label: 'NO GAIN', color: 'bg-gray-500', textColor: 'text-white', sortOrder: 40, estInches: lastIn, remainingInches: remaining });
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
