/**
 * ONE shared physical-readiness ordering contract — pure, node-testable.
 *
 * Used by Dashboard Well Queue, Dashboard Active Jobs (assigned subset per driver),
 * and WB-T's DDJD Job Drawer so all three present the SAME physical order. This is
 * shared presentation/prioritization, NOT automated routing: nothing here creates,
 * assigns, accepts, starts, or dispatches anything.
 *
 * Rules:
 *   - The actual IN-PROGRESS job is pinned first (kept pinned even if its well is
 *     DOWN — alert, never silently replace).
 *   - Remaining jobs use the same physical readiness order as the Well Queue:
 *     by getPriority sortOrder, then hoursUntilPull (earliest ready first; unknown
 *     last), independent of assignment status.
 *   - Deterministic canonical tie-breakers (assignedAt, then id) so order is stable.
 *   - DOWN jobs remain VISIBLE and fully actionable (a DOWN well may still hold pullable
 *     water); they are NOT blocked or removed. They sort to the DOWN tier (last) by the
 *     well classification — never ranked by a stale production TTP — and carry a WELL DOWN
 *     warning on the card. Recommendation is NOT categorically withheld from a DOWN job.
 *   - Recommended-next = the first non-in-progress job in physical order (a ready,
 *     non-DOWN well naturally sorts ahead of DOWN ones, so it is picked first; a DOWN job
 *     is only recommended when nothing better is available). It marks an existing card;
 *     it never spawns a duplicate recommendation card.
 */

export interface PhysicalJobRankInput {
  id: string;
  inProgress: boolean;
  down: boolean;
  /** getPriority(well).sortOrder — lower is more urgent (1 overdue … 4 later, 999 down). */
  sortOrder: number;
  /** getPriority(well).hoursUntilPull — lower is sooner; null = unknown. */
  hoursUntilPull: number | null;
  /** Tie-breaker: assignment time (ms). */
  assignedAtMs: number;
}

const hours = (v: number | null): number => (v == null || !Number.isFinite(v) ? Number.POSITIVE_INFINITY : v);

/** Comparator: in-progress pinned, then physical readiness, then deterministic ties. */
export function comparePhysicalJobs(a: PhysicalJobRankInput, b: PhysicalJobRankInput): number {
  if (a.inProgress !== b.inProgress) return a.inProgress ? -1 : 1; // in-progress pinned first
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder; // Well Queue urgency band
  const ha = hours(a.hoursUntilPull), hb = hours(b.hoursUntilPull);
  if (ha !== hb) return ha - hb;                                    // earliest ready first
  if (a.assignedAtMs !== b.assignedAtMs) return a.assignedAtMs - b.assignedAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;                    // canonical tie-break
}

/** Order a driver's jobs by the shared contract. Pure; does not mutate the input. */
export function orderPhysicalJobs<T extends PhysicalJobRankInput>(jobs: readonly T[]): T[] {
  return [...jobs].sort(comparePhysicalJobs);
}

/**
 * The id of the Recommended-next job: the FIRST non-in-progress job in physical order.
 * DOWN is NOT categorically excluded (a DOWN well may still hold pullable water), but
 * DOWN wells sort to the DOWN tier, so a ready non-DOWN job is naturally chosen first;
 * a DOWN job is only recommended when nothing better is available. Returns null when the
 * only job(s) are in-progress. Marks an existing card — never a separate recommendation card.
 */
export function recommendedNextJobId(jobs: readonly PhysicalJobRankInput[]): string | null {
  const ordered = orderPhysicalJobs(jobs);
  const pick = ordered.find((j) => !j.inProgress);
  return pick ? pick.id : null;
}
