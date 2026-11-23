type ScheduledJob = { id?: string; status?: string; scheduledAt?: string; estimatedEndAt?: string; ongoing?: boolean;
  externalDriverId?: string; wbDriverId?: string };

/** A missing or passed estimated finish keeps an open assignment unavailable until completed. */
export function hasDriverAssignmentConflict(target: ScheduledJob, driverKey: string, jobs: ScheduledJob[], now = Date.now()): boolean {
  const [source, id] = driverKey.split(':');
  return jobs.some(job => {
    if (job.id === target.id || !['assigned', 'in_progress'].includes(job.status || '')
      || (source === 'outside' ? job.externalDriverId !== id : job.wbDriverId !== id)) return false;
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
