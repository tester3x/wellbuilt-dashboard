type ScheduledJob = { id?: string; status?: string; scheduledAt?: string; estimatedEndAt?: string; ongoing?: boolean;
  externalDriverId?: string; wbDriverId?: string; drivers?: { key: string }[] };

export function assignedDriverKeys(job: ScheduledJob): string[] {
  if (Array.isArray(job.drivers)) return job.drivers.map(driver => driver.key);
  return job.externalDriverId ? [`outside:${job.externalDriverId}`] : job.wbDriverId ? [`wellbuilt:${job.wbDriverId}`] : [];
}

/** A missing or passed estimated finish keeps an open assignment unavailable until completed. */
export function hasDriverAssignmentConflict(target: ScheduledJob, driverKey: string, jobs: ScheduledJob[], now = Date.now()): boolean {
  return jobs.some(job => {
    if (job.id === target.id || !['assigned', 'in_progress'].includes(job.status || '')
      || !assignedDriverKeys(job).includes(driverKey)) return false;
    const start = Date.parse(job.scheduledAt || '');
    const end = Date.parse(job.estimatedEndAt || '');
    const requestedStart = Date.parse(target.scheduledAt || '');
    const requestedEnd = Date.parse(target.estimatedEndAt || '');
    const knownFinish = job.ongoing !== true && Number.isFinite(end) && end > now && end > start;
    if (knownFinish && Number.isFinite(requestedStart) && requestedStart >= end) return false;
    if (knownFinish && Number.isFinite(requestedEnd) && Number.isFinite(start) && requestedEnd <= start) return false;
    return true;
  });
}
