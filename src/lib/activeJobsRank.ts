/**
 * Shared bridge between the Well Queue and Active Jobs so BOTH surfaces order the
 * same driver's wells identically. Pure and node-testable.
 *
 * The invariant this enforces:
 *   Active Jobs order (for a driver) === the Well Queue order filtered to that
 *   driver's assigned canonical wells — with two explicit exceptions:
 *     1. the driver's in-progress / started card is pinned first, and
 *     2. a DOWN well stays visible (it sorts to the DOWN tier, never removed).
 *
 * How it holds: a job's physical sortOrder is literally the well's index in the
 * Well-Queue ordering (compareQueueRows over classifyWell at the SAME nowMs).
 * Jobs join their well by canonical NDIC identity via matchWellInPool — never by
 * display-name equality, and a join miss sorts LAST rather than falling back to a
 * stale dispatch TTP/assignedAt. This is shared presentation only: nothing here
 * creates, assigns, accepts, starts, or dispatches anything.
 */
import { classifyWell, compareQueueRows, type QueueRowItem } from './dispatchPriority.ts';
import { matchWellInPool, type WellResponse } from './wellPoolCore.ts';
import { comparePhysicalJobs, type PhysicalJobRankInput } from './physicalJobOrder.ts';

/** Minimal dispatch-job shape needed to rank against the Well Queue. */
export interface RankableJob {
  id?: string;
  wellName?: string;
  ndicWellName?: string;
  status?: string;
  driverStage?: string;
  /** Assignment time in ms (deterministic tie-break only). */
  assignedAtMs?: number;
}

/**
 * Well-Queue rank index: wellName -> its 0-based position in the exact ordering the
 * Well Queue renders. Built once per (wells, nowMs) so every job shares one source.
 */
export function buildWellQueueRankIndex(wells: readonly WellResponse[], nowMs: number): Map<string, number> {
  const rows: QueueRowItem[] = (wells || []).map((w) => ({ well: w, priority: classifyWell(w, nowMs), assignment: undefined }));
  rows.sort(compareQueueRows);
  const m = new Map<string, number>();
  rows.forEach((r, i) => { if (r.well?.wellName) m.set(r.well.wellName, i); });
  return m;
}

/** Join a dispatch job to its canonical well by NDIC identity (never display-name equality). */
export function joinJobWell(job: RankableJob, wells: readonly WellResponse[]): WellResponse | undefined {
  if (!wells || wells.length === 0) return undefined;
  return matchWellInPool(wells, job.ndicWellName) || matchWellInPool(wells, job.wellName);
}

/**
 * Rank input for one job under the shared physical contract. sortOrder is the well's
 * Well-Queue index; a job with no canonical well match sorts last (9999) and one whose
 * well is absent from the index sorts just before it (9998) — never a stale fallback.
 */
export function rankJob(
  job: RankableJob,
  wells: readonly WellResponse[],
  rankIndex: Map<string, number>,
  nowMs: number,
): PhysicalJobRankInput {
  const w = joinJobWell(job, wells);
  const cls = w ? classifyWell(w, nowMs) : null;
  return {
    id: job.id || '',
    // "Current operational job" = the SAME authoritative signal the group header's
    // Driver Started badge uses (job.driverStage non-terminal), or an in_progress status.
    inProgress: (!!job.driverStage && !['completed', 'paused'].includes(job.driverStage)) || job.status === 'in_progress',
    down: cls?.state === 'down',
    sortOrder: w ? (rankIndex.get(w.wellName) ?? 9998) : 9999,
    hoursUntilPull: null,
    assignedAtMs: job.assignedAtMs || 0,
  };
}

/** Order a driver's jobs by the shared physical contract, joined to the live Well Queue. */
export function orderDriverJobs<T extends RankableJob>(jobs: readonly T[], wells: readonly WellResponse[], nowMs: number): T[] {
  const rankIndex = buildWellQueueRankIndex(wells, nowMs);
  const rankById = new Map<string | undefined, PhysicalJobRankInput>(jobs.map((j) => [j.id, rankJob(j, wells, rankIndex, nowMs)]));
  return [...jobs].sort((a, b) => comparePhysicalJobs(rankById.get(a.id)!, rankById.get(b.id)!));
}
