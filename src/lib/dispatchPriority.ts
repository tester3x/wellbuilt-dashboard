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
export function formatTTP(well: WellResponse, nowMs: number = Date.now()): string {
  const p = getPriority(well, nowMs);
  if (p.hoursUntilPull !== null) {
    const h = p.hoursUntilPull;
    if (h <= 0) return 'OVERDUE';
    if (h < 24) return `${Math.round(h)}h`;
    const days = Math.floor(h / 24);
    const rem = Math.round(h % 24);
    return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
  }
  // No live/parsed time (DOWN or unknown) — preserve the prior raw fallback.
  return well.timeTillPull || well.etaToMax || '--';
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

// ─── Actionable queue model (single source of truth) ──────────────────────────
// Views, "needs data" detection, and an honest Level assessment all derive from
// the SAME canonical record (nextPullTimeUTC / lastPullDateTimeUTC) + injected now.

export type QueueBucket = 'needs-pull' | 'next-24h' | 'later' | 'needs-data' | 'down';
export type QueueView = 'needs-pull' | 'next-24h' | 'all' | 'needs-data';

/** The one canonical bucket a well belongs to right now. */
export function wellBucket(well: WellResponse, nowMs: number = Date.now()): QueueBucket {
  if (well.isDown || well.currentLevel === 'DOWN') return 'down';
  const p = getPriority(well, nowMs);
  if (p.level === 'unknown') return 'needs-data';      // no valid prediction input
  if (p.level === 'overdue') return 'needs-pull';       // ready / overdue → act now
  if (p.level === 'soon' || p.level === 'today') return 'next-24h';
  return 'later';                                        // days away
}

/** True when the well has a usable prediction (else the row shows NEEDS DATA). */
export function hasValidPrediction(well: WellResponse, nowMs: number = Date.now()): boolean {
  const b = wellBucket(well, nowMs);
  return b !== 'needs-data' && b !== 'down';
}

/** Does this well match the selected primary view? (down wells never match.) */
export function matchesView(well: WellResponse, view: QueueView, nowMs: number = Date.now()): boolean {
  const b = wellBucket(well, nowMs);
  if (b === 'down') return false;
  switch (view) {
    case 'needs-pull': return b === 'needs-pull';
    case 'next-24h': return b === 'next-24h';
    case 'needs-data': return b === 'needs-data';
    case 'all': return true; // every non-down well
  }
}

export interface LevelAssessment {
  lastLevel: string | null;       // last MEASURED post-pull level (historical)
  lastLevelAgeHours: number | null;
  estNow: string;                 // 'OVER' | '~NN%' | 'NEEDS DATA' | '--'
  isHistoricalOnly: boolean;      // true → do not present lastLevel as current
}

/**
 * Honest level assessment. `lastLevel` is the last measured post-pull reading
 * (with age); `estNow` is a live projection from the canonical fill cycle
 * (lastPull→nextPull): 'OVER' once the predicted-ready time has passed, else the
 * % of the cycle elapsed. Never presents a historical reading as the current tank.
 */
export function assessLevel(well: WellResponse, nowMs: number = Date.now()): LevelAssessment {
  if (well.isDown || well.currentLevel === 'DOWN') {
    return { lastLevel: null, lastLevelAgeHours: null, estNow: '--', isHistoricalOnly: false };
  }
  const lastTsStr = well.lastPullDateTimeUTC || well.timestampUTC || '';
  const lastTs = lastTsStr ? new Date(lastTsStr).getTime() : NaN;
  const ageHours = !isNaN(lastTs) ? (nowMs - lastTs) / 3600_000 : null;
  const lastLevel =
    (well.lastPullBottomLevel && well.lastPullBottomLevel.trim()) ? well.lastPullBottomLevel.trim()
    : (well.currentLevel && well.currentLevel !== '--') ? well.currentLevel
    : null;

  const p = getPriority(well, nowMs);
  let estNow = '--';
  if (p.level === 'unknown') {
    estNow = 'NEEDS DATA';
  } else if (p.hoursUntilPull !== null && p.hoursUntilPull <= 0) {
    estNow = 'OVER';
  } else if (well.nextPullTimeUTC && !isNaN(lastTs)) {
    const t1 = new Date(well.nextPullTimeUTC).getTime();
    if (!isNaN(t1) && t1 > lastTs) {
      const frac = Math.min(1, Math.max(0, (nowMs - lastTs) / (t1 - lastTs)));
      estNow = `~${Math.round(frac * 100)}%`;
    }
  }
  // Historical-only when the reading is stale relative to the prediction: overdue,
  // or the last reading is older than ~6h (a post-pull snapshot no longer "current").
  const isHistoricalOnly = estNow === 'OVER' || (ageHours !== null && ageHours >= 6);
  return { lastLevel, lastLevelAgeHours: ageHours, estNow, isHistoricalOnly };
}

/** Compact age label, e.g. "18h ago", "3d ago", "45m ago". */
export function formatAge(hours: number | null): string {
  if (hours === null || isNaN(hours)) return '';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
