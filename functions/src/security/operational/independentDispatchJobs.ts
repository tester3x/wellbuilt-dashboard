import { isIndependentSector, parseSectorFields } from './independentDispatchSectors';

export const JOB_STATUSES = ['unassigned', 'assigned', 'in_progress', 'completed', 'cancelled'] as const;
export type IndependentJobStatus = typeof JOB_STATUSES[number];
export type IndependentJobDetails = {
  title: string; customer: string; reference: string; pickup: string; destination: string;
  cargo: string; scheduledAt: string; estimatedEndAt: string; notes: string;
  shift: '' | 'day' | 'night' | 'both'; ongoing: boolean;
  jobContactName?: string; jobContactRole?: string; jobContactPhoneE164?: string;
  customerId?: string; sector?: string; sectorFields?: Record<string, string>;
  categoryId?: string; asset?: string;
};
const LIMITS: Record<'title' | 'customer' | 'reference' | 'pickup' | 'destination' | 'cargo' | 'scheduledAt' | 'estimatedEndAt' | 'notes'
  | 'jobContactName' | 'jobContactRole' | 'jobContactPhoneE164', number> = {
  title: 180, customer: 180, reference: 120, pickup: 500, destination: 500,
  cargo: 500, scheduledAt: 40, estimatedEndAt: 40, notes: 4000, jobContactName: 120, jobContactRole: 80, jobContactPhoneE164: 16,
};
export function parseIndependentJob(raw: unknown): IndependentJobDetails {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_job');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.prototype.hasOwnProperty.call(LIMITS, key)
    && !['customerId', 'sector', 'sectorFields', 'categoryId', 'asset', 'shift', 'ongoing'].includes(key))) throw Error('unexpected_job_field');
  const job = {} as IndependentJobDetails;
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > LIMITS[key]) throw Error(`invalid_${key}`);
    job[key] = value.trim();
  }
  for (const key of ['title', 'customer', 'pickup', 'destination'] as const) {
    if (!job[key]) throw Error(`required_${key}`);
  }
  if (input.shift !== undefined && !['', 'day', 'night', 'both'].includes(input.shift as string)) throw Error('invalid_shift');
  if (input.ongoing !== undefined && typeof input.ongoing !== 'boolean') throw Error('invalid_ongoing');
  job.shift = (input.shift || '') as IndependentJobDetails['shift'];
  job.ongoing = input.ongoing === true;
  if (job.jobContactPhoneE164 && !/^\+[1-9]\d{7,14}$/.test(job.jobContactPhoneE164)) throw Error('invalid_job_contact_phone');
  if ((job.jobContactPhoneE164 || job.jobContactRole) && !job.jobContactName) throw Error('required_job_contact_name');
  if (job.scheduledAt && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(job.scheduledAt)
    || !Number.isFinite(Date.parse(job.scheduledAt)) || new Date(job.scheduledAt).toISOString() !== job.scheduledAt)) throw Error('invalid_scheduledAt');
  if (job.estimatedEndAt && (!job.scheduledAt || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(job.estimatedEndAt)
    || !Number.isFinite(Date.parse(job.estimatedEndAt)) || new Date(job.estimatedEndAt).toISOString() !== job.estimatedEndAt
    || Date.parse(job.estimatedEndAt) <= Date.parse(job.scheduledAt))) throw Error('invalid_estimatedEndAt');
  if (input.sector !== undefined || input.customerId !== undefined || input.sectorFields !== undefined) {
    if (!isIndependentSector(input.sector)) throw Error('invalid_sector');
    if (input.customerId !== undefined && (typeof input.customerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.customerId))) throw Error('invalid_customerId');
    job.sector = input.sector;
    if (input.customerId !== undefined) job.customerId = input.customerId as string;
    job.sectorFields = parseSectorFields(input.sector, input.sectorFields);
  }
  if (input.categoryId !== undefined || input.asset !== undefined) {
    if (!job.customerId || !job.sector || typeof input.categoryId !== 'string' || (input.categoryId !== '' && !/^[A-Za-z0-9_-]{1,100}$/.test(input.categoryId)))
      throw Error('invalid_categoryId');
    if (input.asset !== undefined && (typeof input.asset !== 'string' || input.asset.length > 180)) throw Error('invalid_asset');
    if (!input.categoryId && input.asset) throw Error('asset_requires_category');
    job.categoryId = input.categoryId;
    job.asset = typeof input.asset === 'string' ? input.asset.trim() : '';
  }
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
