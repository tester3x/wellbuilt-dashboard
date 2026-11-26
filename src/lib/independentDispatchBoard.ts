import type { IndependentJob, IndependentJobStatus } from './independentDispatchJobs';

export const ACTIVE_LANES: { status: IndependentJobStatus; label: string; hint: string }[] = [
  { status: 'unassigned', label: 'Needs a driver', hint: 'Requests waiting for someone to take them' },
  { status: 'assigned', label: 'Assigned', hint: 'Driver chosen; waiting to start' },
  { status: 'in_progress', label: 'In progress', hint: 'Work underway' },
];

export function sortDispatchJobs(jobs: IndependentJob[], history = false): IndependentJob[] {
  return [...jobs].sort((a, b) => {
    if (history) return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    const aDue = a.scheduledAt ? Date.parse(a.scheduledAt) : Number.POSITIVE_INFINITY;
    const bDue = b.scheduledAt ? Date.parse(b.scheduledAt) : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return Date.parse(a.createdAt || a.updatedAt) - Date.parse(b.createdAt || b.updatedAt);
  });
}

export function pickupTiming(job: IndependentJob, now = Date.now()): 'overdue' | 'soon' | 'later' | 'unscheduled' {
  if (!job.scheduledAt || !Number.isFinite(Date.parse(job.scheduledAt))) return 'unscheduled';
  const remaining = Date.parse(job.scheduledAt) - now;
  if (remaining < 0) return 'overdue';
  if (remaining <= 24 * 60 * 60 * 1000) return 'soon';
  return 'later';
}
