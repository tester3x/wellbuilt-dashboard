import { LEGACY_WELL_POOL_COMPANY_ID } from '../dashboardCatalogProjection';

export const PROJECT_CREATE_ALLOWLIST = [
  'name',
  'wellNames',
  'operatorName',
  'companyId',
  'createdBy',
  'startDate',
  'projectedEndDate',
  'status',
  'jobType',
  'serviceType',
  'notes',
  'driverSchedule',
  'dayDriverHashes',
  'nightDriverHashes',
  'driverDisposals',
] as const;

export const PROJECT_STATUSES = ['active', 'paused', 'completed'] as const;

export type ProjectWriteOp = 'create' | 'update';

export type ProjectWriteResult =
  | { ok: true; op: ProjectWriteOp; companyId: string }
  | { ok: false; reason: string };

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function evaluateStaffWriteProject(input: {
  op: ProjectWriteOp;
  existing: Record<string, unknown> | null;
  record?: Record<string, unknown>;
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
}): ProjectWriteResult {
  const record = input.record || {};
  if (input.op === 'create') {
    if (!asString(record.name)) return { ok: false, reason: 'name_required' };
    const status = asString(record.status) || 'active';
    if (!(PROJECT_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, reason: 'invalid_status' };
    }
    if (input.isPlatformAdmin) {
      return { ok: true, op: 'create', companyId: asString(record.companyId) || LEGACY_WELL_POOL_COMPANY_ID };
    }
    const caller = (input.callerCompanyId || '').trim();
    if (!caller) return { ok: false, reason: 'unscoped_caller' };
    if (asString(record.companyId) && asString(record.companyId) !== caller) {
      return { ok: false, reason: 'cross_company' };
    }
    return { ok: true, op: 'create', companyId: caller };
  }
  if (!input.existing) return { ok: false, reason: 'unknown_project' };
  const companyId = asString(input.existing.companyId);
  if (!input.isPlatformAdmin) {
    const caller = (input.callerCompanyId || '').trim();
    if (!caller || (companyId && companyId !== caller)) return { ok: false, reason: 'cross_company' };
  }
  const next = asString(record.status);
  if (next && !(PROJECT_STATUSES as readonly string[]).includes(next)) {
    return { ok: false, reason: 'invalid_status' };
  }
  return { ok: true, op: 'update', companyId: companyId || (input.callerCompanyId || LEGACY_WELL_POOL_COMPANY_ID) };
}

export function pickProjectFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PROJECT_CREATE_ALLOWLIST) {
    if (key in record && record[key] !== undefined) out[key] = record[key];
  }
  delete out.companyId;
  return out;
}
