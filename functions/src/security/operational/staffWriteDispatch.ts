import { LEGACY_WELL_POOL_COMPANY_ID } from '../dashboardCatalogProjection';

/** Every business field the Dispatch UI actually sends on create/update. */
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
  'transferReason',
  'projectId',
  'splitGroupId',
  'splitSequence',
  'splitTotal',
  'bbls',
  'isHeavyWater',
  'onsiteBy',
  'hauledTo',
  'assignedAt',
] as const;

export const DISPATCH_UPDATE_ALLOWLIST = [
  ...DISPATCH_CREATE_ALLOWLIST,
  'totalBBL',
  'invoiceNumber',
  'reassignedTo',
] as const;

export const SERVER_AUTHORITATIVE_CREATE_FIELDS = ['assignedAt', 'companyId'] as const;

export const DECLINE_FIELDS = ['declinedAt', 'declineReason', 'declinedBy'] as const;

export const KNOWN_STATUSES = [
  'pending',
  'pending_approval',
  'accepted',
  'in_progress',
  'paused',
  'completed',
  'cancelled',
  'declined',
  'dismissed',
] as const;

/** Statuses Dashboard workflows actually create. */
export const CREATE_STATUSES = ['pending'] as const;

/** Cancel is allowed from these; rejected from terminal states below. */
export const CANCEL_ALLOWED_FROM = [
  'pending',
  'pending_approval',
  'accepted',
  'in_progress',
  'paused',
] as const;

export const CANCEL_TERMINAL = ['completed', 'dismissed', 'declined'] as const;

/**
 * Exact status transition table for staffWriteDispatch.
 * Key = current status; value = statuses an update may set.
 * omitted status on update = no transition (field patch only).
 */
export const UPDATE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  pending: [],
  pending_approval: ['pending'],
  accepted: [],
  in_progress: [],
  paused: [],
  completed: [],
  cancelled: [],
  declined: [],
  dismissed: [],
};

export type StaffWriteOp = 'create' | 'update' | 'cancel';

export type StaffWriteResult =
  | { ok: true; op: StaffWriteOp; companyId: string; idempotent?: boolean; status?: string }
  | { ok: false; reason: string; field?: string };

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function jobCompany(job: Record<string, unknown> | null): string {
  return job ? asString(job.companyId) : '';
}

export function callerMayTouchCompany(
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

function isKnownStatus(status: string): boolean {
  return (KNOWN_STATUSES as readonly string[]).includes(status);
}

export function isTimestampLike(val: unknown): val is { toMillis: () => number } {
  return !!val && typeof val === 'object' && typeof (val as { toMillis?: unknown }).toMillis === 'function';
}

export function serializeTimestamp(val: { toMillis: () => number }): { seconds: number; nanoseconds: number } {
  const ms = val.toMillis();
  return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
}

/**
 * Client/server shared serializer. assignedAt is omitted so the server can
 * stamp it. Any other Timestamp-like value is serialized, never dropped.
 * Unknown objects that look like Timestamps on non-allowlisted keys reject.
 */
export function serializeStaffDispatchRecord(
  record: Record<string, unknown>,
  allow: readonly string[],
): StaffWriteResult & { record?: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (val === undefined) continue;
    if ((DECLINE_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, reason: 'decline_fields_immutable', field: key };
    }
    if (isTimestampLike(val)) {
      if ((SERVER_AUTHORITATIVE_CREATE_FIELDS as readonly string[]).includes(key)) {
        continue;
      }
      if (!(allow as readonly string[]).includes(key)) {
        return { ok: false, reason: 'unexpected_field', field: key };
      }
      out[key] = serializeTimestamp(val);
      continue;
    }
    out[key] = val;
  }
  return { ok: true, op: 'create', companyId: '', record: out };
}

export function unexpectedDispatchFields(
  record: Record<string, unknown>,
  allow: readonly string[],
): string[] {
  const allowed = new Set<string>([...allow, ...SERVER_AUTHORITATIVE_CREATE_FIELDS]);
  return Object.keys(record).filter((key) => record[key] !== undefined && !allowed.has(key));
}

export function pickDispatchFields(
  record: Record<string, unknown>,
  allow: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    if (key in record && record[key] !== undefined) out[key] = record[key];
  }
  for (const key of SERVER_AUTHORITATIVE_CREATE_FIELDS) {
    delete out[key];
  }
  for (const key of DECLINE_FIELDS) {
    delete out[key];
  }
  return out;
}

export function evaluateStaffWriteDispatch(input: {
  op: StaffWriteOp;
  job: Record<string, unknown> | null;
  record?: Record<string, unknown>;
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
}): StaffWriteResult {
  const record = input.record || {};

  for (const key of DECLINE_FIELDS) {
    if (key in record && record[key] !== undefined) {
      return { ok: false, reason: 'decline_fields_immutable', field: key };
    }
  }

  if (input.op === 'create') {
    const unknown = unexpectedDispatchFields(record, DISPATCH_CREATE_ALLOWLIST);
    if (unknown.length) return { ok: false, reason: 'unexpected_field', field: unknown[0] };
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
    if (!isKnownStatus(status)) return { ok: false, reason: 'unknown_status', field: status };
    if (status === 'dismissed') return { ok: false, reason: 'use_dismiss_callable' };
    if (!(CREATE_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, reason: 'invalid_create_status', field: status };
    }
    return { ok: true, op: 'create', companyId, status };
  }

  if (!input.job) return { ok: false, reason: 'unknown_dispatch' };
  const companyId = jobCompany(input.job);
  if (!callerMayTouchCompany(companyId, input.callerCompanyId, input.isPlatformAdmin)) {
    return { ok: false, reason: companyId ? 'cross_company' : 'unscoped_dispatch' };
  }
  const resolvedCompany = companyId || (input.callerCompanyId || LEGACY_WELL_POOL_COMPANY_ID);
  const current = asString(input.job.status);

  if (input.op === 'cancel') {
    if (current === 'cancelled') {
      return { ok: true, op: 'cancel', companyId: resolvedCompany, idempotent: true, status: 'cancelled' };
    }
    if ((CANCEL_TERMINAL as readonly string[]).includes(current)) {
      return { ok: false, reason: 'terminal_state', field: current };
    }
    if (current && !isKnownStatus(current)) return { ok: false, reason: 'unknown_status', field: current };
    if (!(CANCEL_ALLOWED_FROM as readonly string[]).includes(current)) {
      return { ok: false, reason: 'invalid_cancel_status', field: current };
    }
    return { ok: true, op: 'cancel', companyId: resolvedCompany, status: 'cancelled' };
  }

  const unknown = unexpectedDispatchFields(record, DISPATCH_UPDATE_ALLOWLIST);
  if (unknown.length) return { ok: false, reason: 'unexpected_field', field: unknown[0] };
  if (asString(record.companyId) && asString(record.companyId) !== companyId && companyId) {
    return { ok: false, reason: 'company_immutable' };
  }
  const next = asString(record.status);
  if (next) {
    if (!isKnownStatus(next)) return { ok: false, reason: 'unknown_status', field: next };
    if (next === 'dismissed') return { ok: false, reason: 'use_dismiss_callable' };
    if (next !== current) {
      const allowed = UPDATE_STATUS_TRANSITIONS[current] || [];
      if (!allowed.includes(next)) {
        return { ok: false, reason: 'invalid_transition', field: `${current}->${next}` };
      }
    }
  }
  return { ok: true, op: 'update', companyId: resolvedCompany, status: next || current };
}

export function materializeStaffCreate(
  record: Record<string, unknown>,
  caller: { companyId?: string; isPlatformAdmin: boolean },
): { ok: true; fields: Record<string, unknown>; companyId: string } | { ok: false; reason: string; field?: string } {
  const serialized = serializeStaffDispatchRecord(record, DISPATCH_CREATE_ALLOWLIST);
  if (!serialized.ok) return serialized;
  const body = serialized.record || {};
  const decided = evaluateStaffWriteDispatch({
    op: 'create',
    job: null,
    record: body,
    callerCompanyId: caller.companyId,
    isPlatformAdmin: caller.isPlatformAdmin,
  });
  if (!decided.ok) return decided;
  const fields = pickDispatchFields(body, DISPATCH_CREATE_ALLOWLIST);
  fields.companyId = decided.companyId;
  fields.status = decided.status || 'pending';
  fields.assignedAt = { _serverTimestamp: true };
  return { ok: true, fields, companyId: decided.companyId };
}
