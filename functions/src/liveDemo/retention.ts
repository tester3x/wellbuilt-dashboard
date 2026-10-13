/** Keep whole completed scenarios so split tickets never lose one leg. */
export const MAX_COMPLETED_DEMO_JOBS = 24;

export function demoScenariosToPrune(
  completed: ReadonlyArray<{ id: string; jobCount: number }>,
): string[] {
  const newestFirst = [...completed].sort((a, b) => b.id.localeCompare(a.id));
  let keptJobs = 0;
  let reachedCap = false;
  const remove: string[] = [];
  for (const run of newestFirst) {
    if (run.jobCount < 1 || run.jobCount > MAX_COMPLETED_DEMO_JOBS) throw new Error('invalid_demo_job_count');
    if (!reachedCap && keptJobs + run.jobCount <= MAX_COMPLETED_DEMO_JOBS) keptJobs += run.jobCount;
    else { reachedCap = true; remove.push(run.id); }
  }
  return remove;
}
