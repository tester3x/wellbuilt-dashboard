export const JOB_STATUSES = ['unassigned', 'assigned', 'in_progress', 'completed', 'cancelled'] as const;
export type IndependentJobStatus = typeof JOB_STATUSES[number];
export type IndependentJobDetails = {
  title: string; customer: string; reference: string; pickup: string; destination: string;
  cargo: string; scheduledAt: string; notes: string;
};
const LIMITS: Record<keyof IndependentJobDetails, number> = {
  title: 180, customer: 180, reference: 120, pickup: 500, destination: 500,
  cargo: 500, scheduledAt: 40, notes: 4000,
};
export function parseIndependentJob(raw: unknown): IndependentJobDetails {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_job');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.prototype.hasOwnProperty.call(LIMITS, key))) throw Error('unexpected_job_field');
  const job = {} as IndependentJobDetails;
  for (const key of Object.keys(LIMITS) as (keyof IndependentJobDetails)[]) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > LIMITS[key]) throw Error(`invalid_${key}`);
    job[key] = value.trim();
  }
  for (const key of ['title', 'customer', 'pickup', 'destination'] as const) {
    if (!job[key]) throw Error(`required_${key}`);
  }
  if (job.scheduledAt && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(job.scheduledAt)
    || !Number.isFinite(Date.parse(job.scheduledAt)) || new Date(job.scheduledAt).toISOString() !== job.scheduledAt)) throw Error('invalid_scheduledAt');
  return job;
}
export function independentJobTransition(current: IndependentJobStatus, next: IndependentJobStatus): boolean {
  return ({
    unassigned: ['cancelled'], assigned: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'], completed: [], cancelled: [],
  } as Record<IndependentJobStatus, string[]>)[current]?.includes(next) === true;
}
export function assertIndependentJobMutable(status: string) {
  if (!['unassigned', 'assigned'].includes(status)) throw Error('job_not_editable');
}
