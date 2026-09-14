// dispatchAssignmentGroups — Firebase-free lifecycle grouping for the Needs Pull
// queue. A PW dispatch's status decides whether its well is:
//   started    → represented by Active Jobs (removed from Needs Pull)
//   not_started→ assigned but not started → dimmed bottom group of Needs Pull
//   inactive   → declined/cancelled/dismissed/completed/none → free to re-enter
// Needs Pull the instant the live classifier still says it needs pulling.

export const PW_STARTED_STATUSES = ['in_progress', 'paused'] as const;
export const PW_NOT_STARTED_STATUSES = ['pending', 'pending_approval', 'accepted'] as const;
export const PW_ACTIVE_STATUSES = [...PW_NOT_STARTED_STATUSES, ...PW_STARTED_STATUSES] as const;

export type PwLifecycle = 'started' | 'not_started' | 'inactive';

export function pwLifecycle(status: string | null | undefined): PwLifecycle {
  if (!status) return 'inactive';
  if ((PW_STARTED_STATUSES as readonly string[]).includes(status)) return 'started';
  if ((PW_NOT_STARTED_STATUSES as readonly string[]).includes(status)) return 'not_started';
  return 'inactive';
}

export interface PwQueueItem {
  /** stable identity (well name) */
  key: string;
  /** the well is PHYSICALLY pull-now per the live classifier (assigned:false) */
  isPullNow: boolean;
  /** absolute predicted ready time (ms) for actionable ordering */
  predictedReadyAtMs: number | null;
  /** active pw dispatch status for this well, if any */
  assignedStatus?: string | null;
  /** assignedAt (ms) for STABLE ordering of the assigned group */
  assignedMs?: number;
}

/**
 * Split physically-pull-now wells into the two ordered Needs Pull groups and the
 * physical-demand counts. Started wells are excluded (Active Jobs). Unassigned are
 * ordered by absolute predicted ready time; the assigned group is ordered by
 * assigned-time (stable — live-level updates do not make it jump around).
 */
export function partitionNeedsPull<T extends PwQueueItem>(items: T[]): {
  unassigned: T[];
  assigned: T[];
  counts: { total: number; unassigned: number; assigned: number };
} {
  const unassigned: T[] = [];
  const assigned: T[] = [];
  for (const it of items) {
    const lc = pwLifecycle(it.assignedStatus);
    if (lc === 'started') continue;   // represented by Active Jobs
    if (!it.isPullNow) continue;      // Needs Pull = physical demand only
    if (lc === 'not_started') assigned.push(it);
    else unassigned.push(it);
  }
  unassigned.sort((a, b) => (a.predictedReadyAtMs ?? Number.POSITIVE_INFINITY) - (b.predictedReadyAtMs ?? Number.POSITIVE_INFINITY));
  assigned.sort((a, b) => (a.assignedMs ?? 0) - (b.assignedMs ?? 0));
  return { unassigned, assigned, counts: { total: unassigned.length + assigned.length, unassigned: unassigned.length, assigned: assigned.length } };
}
