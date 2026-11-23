import type { IndependentJob } from './independentDispatchJobs';

export type DriverAvailability = { available: boolean; label: string };

export function driverAvailability(target: IndependentJob, driverKey: string, jobs: IndependentJob[], active: boolean, now = Date.now()): DriverAvailability {
  if (!active) return { available: false, label: 'Inactive' };
  const otherJobs = jobs.filter(job => job.id !== target.id && ['assigned', 'in_progress'].includes(job.status)
    && (Array.isArray(job.drivers) ? job.drivers.some(driver => driver.key === driverKey)
      : driverKey.startsWith('outside:') ? job.externalDriverId === driverKey.slice(8) : job.wbDriverId === driverKey.slice(10)));
  for (const job of otherJobs) {
    const start = Date.parse(job.scheduledAt || '');
    const end = Date.parse(job.estimatedEndAt || '');
    const requestedStart = Date.parse(target.scheduledAt || '');
    const requestedEnd = Date.parse(target.estimatedEndAt || '');
    const knownFinish = job.ongoing !== true && Number.isFinite(end) && end > now && end > start;
    const finishesBeforeRequest = knownFinish && Number.isFinite(requestedStart) && requestedStart >= end;
    const requestFinishesBeforeJob = knownFinish && Number.isFinite(requestedEnd) && Number.isFinite(start) && requestedEnd <= start;
    if (finishesBeforeRequest || requestFinishesBeforeJob) continue;
    return { available: false, label: `${job.status === 'in_progress' ? 'In progress' : 'Assigned'} · ${job.ongoing ? 'ongoing work' : knownFinish ? 'time overlaps' : 'finish unknown'} · ${job.title}` };
  }
  return { available: true, label: otherJobs.length ? 'Available for this job · other work does not overlap' : 'Available' };
}
