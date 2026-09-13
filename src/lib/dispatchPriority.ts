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
