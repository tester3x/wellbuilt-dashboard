import { LEGACY_WELL_POOL_COMPANY_ID } from '../dashboardCatalogProjection';

export const DISPATCH_CREATE_ALLOWLIST = [
  'companyId',
  'driverHash',
  'driverName',
  'driverFirstName',
  'wellName',
  'ndicWellName',
  'operator',
  'route',
  'jobType',
  'serviceType',
  'packageId',
  'status',
  'notes',
  'priority',
  'assignedBy',
  'estimatedPullTime',
  'currentLevel',
  'flowRate',
  'disposal',
  'disposalLat',
  'disposalLng',
  'disposalApiNo',
  'disposalLegalDesc',
  'disposalCounty',
  'loadCount',
  'loadsCompleted',
  'serviceGroupId',
  'assignedDrivers',
  'type',
  'transferFromDriver',
  'transferFromDriverHash',
  'sourceInvoiceDocId',
  'sourceInvoiceNumber',
  'intendedDriverHash',
  'intendedDriverName',
  'projectId',
  'splitGroupId',
  'splitSequence',
  'isHeavyWater',
  'onsiteBy',
  'hauledTo',
] as const;

export const DISPATCH_UPDATE_ALLOWLIST = [
  ...DISPATCH_CREATE_ALLOWLIST,
  'ndicWellName',
  'totalBBL',
  'invoiceNumber',
  'reassignedTo',
] as const;

export type StaffWriteOp = 'create' | 'update' | 'cancel';

export type StaffWriteResult =
  | { ok: true; op: StaffWriteOp; companyId: string }
  | { ok: false; reason: string };

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function jobCompany(job: Record<string, unknown> | null): string {
  return job ? asString(job.companyId) : '';
}

function callerMayTouchCompany(
  jobCompanyId: string,
  callerCompanyId: string | undefined,
  isPlatformAdmin: boolean,
): boolean {
  if (isPlatformAdmin) return true;
  const caller = (callerCompanyId || '').trim();
  if (!caller) return false;
  if (jobCompanyId === caller) return true;
  return caller === LEGACY_WELL_POOL_COMPANY_ID && !jobCompanyId;
}

export function evaluateStaffWriteDispatch(input: {
  op: StaffWriteOp;
  job: Record<string, unknown> | null;
  record?: Record<string, unknown>;
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
}): StaffWriteResult {
  if (input.op === 'create') {
    const record = input.record || {};
    const wellName = asString(record.wellName) || asString(record.ndicWellName);
    if (!wellName) return { ok: false, reason: 'well_required' };
    let companyId = asString(record.companyId);
    if (input.isPlatformAdmin) {
      companyId = companyId || LEGACY_WELL_POOL_COMPANY_ID;
    } else {
      const caller = (input.callerCompanyId || '').trim();
      if (!caller) return { ok: false, reason: 'unscoped_caller' };
      if (companyId && companyId !== caller) return { ok: false, reason: 'cross_company' };
      companyId = caller;
    }
    const status = asString(record.status) || 'pending';
    if (status === 'dismissed') return { ok: false, reason: 'use_dismiss_callable' };
    return { ok: true, op: 'create', companyId };
  }

  if (!input.job) return { ok: false, reason: 'unknown_dispatch' };
  const companyId = jobCompany(input.job);
  if (!callerMayTouchCompany(companyId, input.callerCompanyId, input.isPlatformAdmin)) {
    return { ok: false, reason: companyId ? 'cross_company' : 'unscoped_dispatch' };
  }
  if (input.op === 'cancel') {
    return { ok: true, op: 'cancel', companyId: companyId || (input.callerCompanyId || LEGACY_WELL_POOL_COMPANY_ID) };
  }
  const patch = input.record || {};
  if (asString(patch.status) === 'dismissed') return { ok: false, reason: 'use_dismiss_callable' };
  if (asString(patch.companyId) && asString(patch.companyId) !== companyId && companyId) {
    return { ok: false, reason: 'company_immutable' };
  }
  return { ok: true, op: 'update', companyId: companyId || (input.callerCompanyId || LEGACY_WELL_POOL_COMPANY_ID) };
}

export function pickDispatchFields(
  record: Record<string, unknown>,
  allow: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    if (key in record && record[key] !== undefined) out[key] = record[key];
  }
  return out;
}
