import { LEGACY_WELL_POOL_COMPANY_ID } from '../dashboardCatalogProjection';
import {
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
  type TrustedCompanyAuthority,
} from '../trustedStaffAuthority';

/** Every business field the Dispatch UI actually sends on create/update. */
export const DISPATCH_CREATE_ALLOWLIST = [
  'companyId',
  'driverId',
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
  ...DISPATCH_CREATE_ALLOWLIST.filter((k) => k !== 'packageId'),
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

/** Capability the staffWriteDispatch callable requires on trusted_staff_authority. */
export const STAFF_WRITE_DISPATCH_REQUIRED_CAPABILITY = TRUSTED_CAPABILITY_MANAGE_DRIVERS;

export const STAFF_WRITE_DISPATCH_FORBIDDEN_REQUEST_KEYS = Object.freeze([
  'companyId',
  'targetCompanyId',
  'publisherUid',
  'publisher',
  'publishedByUid',
  'uid',
  'role',
  'roles',
  'capabilities',
  'manageDrivers',
  'isPlatformAdmin',
  'wellbuiltAdmin',
  'platformAdmin',
] as const);

/**
 * Convert a proven trusted-authority result into the C3 staff caller.
 * Platform-admin is never true here — companyId is exclusively the trusted record's.
 */
export function staffWriteDispatchAccessFromTrusted(
  authority: TrustedCompanyAuthority | null,
): { ok: true; uid: string; companyId: string; isPlatformAdmin: false } | { ok: false; reason: string } {
  if (!authority?.uid) return { ok: false, reason: 'unauthenticated' };
  const companyId = typeof authority.companyId === 'string' ? authority.companyId.trim() : '';
  if (!companyId) return { ok: false, reason: 'missing_company' };
  return { ok: true, uid: authority.uid, companyId, isPlatformAdmin: false };
}

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
    const requestedCompany = asString(record.companyId);
    let companyId = '';
    if (input.isPlatformAdmin) {
      // Platform admin: the acting company is the SERVER-VALIDATED target that the
      // callable resolved (companies/{target} exists / not archived) and passes as
      // callerCompanyId. A bare record.companyId never selects a tenant — it must
      // equal that validated target, and a platform-admin create with no validated
      // target is rejected rather than silently defaulted to the legacy pool.
      const target = (input.callerCompanyId || '').trim();
      if (!target) return { ok: false, reason: 'target_company_required', field: 'companyId' };
      if (requestedCompany && requestedCompany !== target) {
        return { ok: false, reason: 'target_company_mismatch', field: 'companyId' };
      }
      companyId = target;
    } else {
      const caller = (input.callerCompanyId || '').trim();
      if (!caller) return { ok: false, reason: 'unscoped_caller' };
      if (requestedCompany && requestedCompany !== caller) return { ok: false, reason: 'cross_company' };
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

/**
 * A canonical driver id is the immutable UUID (dash-bearing) — never a 64-hex
 * passcode hash or a drivers/approved record key that happens to be a hash.
 */
export function isCanonicalDriverId(id: unknown): boolean {
  const s = asString(id);
  return s.length > 0 && s.includes('-');
}

/** Authoritative driver profile fields the server resolves against (never client-supplied). */
export interface DispatchDriverProfile {
  companyId: string | null;
  legalName: string | null;
  displayName: string | null;
  active: boolean;
  exists: boolean;
}

/**
 * SERVER-AUTHORITATIVE dispatch identity resolution.
 *
 * The Dashboard client is not trusted for the driver's stored identity. Given the
 * client-supplied driver keys and the driver's canonical profile (resolved by the
 * caller from drivers/profiles/{driverId}), this returns the identity fields the
 * server will STAMP:
 *   - driverId   : canonical UUID
 *   - driverHash : canonical UUID (temporary compatibility value)
 *   - driverName : the driver's REAL name (legalName → displayName), never the login
 *
 * Rules:
 *   - A canonical driverId is required to store a canonical identity; it is taken from
 *     the client driverId (UUID) or, failing that, a client driverHash that is itself a
 *     canonical UUID.
 *   - When the profile resolves and declares a companyId that differs from this
 *     dispatch's company, the write is REJECTED (no cross-company assignment) — unless
 *     the dispatch company is the legacy well pool (platform-admin unscoped path).
 *   - When no canonical id exists (legacy driver), the client driverHash/driverName pass
 *     through as a compatibility fallback and no driverId is stamped.
 */
export function resolveServerAssignmentIdentity(input: {
  clientDriverId?: unknown;
  clientDriverHash?: unknown;
  clientDriverName?: unknown;
  profile?: DispatchDriverProfile | null;
  dispatchCompanyId: string;
  legacyWellPoolCompanyId: string;
}):
  | { ok: true; fields: { driverId?: string; driverHash?: string; driverName?: string } }
  | { ok: false; reason: string; field?: string } {
  const clientId = asString(input.clientDriverId);
  const clientHash = asString(input.clientDriverHash);
  const canonical = isCanonicalDriverId(clientId)
    ? clientId
    : isCanonicalDriverId(clientHash)
      ? clientHash
      : '';

  if (!canonical) {
    if (clientId || clientHash) return { ok: false, reason: 'driver_not_canonical' };
    return { ok: true, fields: {} };
  }

  const profile = input.profile;
  if (!profile || !profile.exists) {
    return { ok: false, reason: 'driver_not_found' };
  }
  if (profile.active === false) {
    return { ok: false, reason: 'driver_inactive' };
  }
  const profileCompany = asString(profile.companyId);
  const dispatchCompany = asString(input.dispatchCompanyId);
  const legacyPool = asString(input.legacyWellPoolCompanyId);
  if (
    profileCompany &&
    dispatchCompany &&
    dispatchCompany !== legacyPool &&
    profileCompany !== dispatchCompany
  ) {
    return { ok: false, reason: 'driver_company_mismatch', field: profileCompany };
  }
  const realName = asString(profile.legalName) || asString(profile.displayName);
  if (!realName) return { ok: false, reason: 'driver_name_unresolved' };
  return { ok: true, fields: { driverId: canonical, driverHash: canonical, driverName: realName } };
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
  delete fields.packageId;
  delete fields.packetRevision;
  delete fields.contentHash;
  delete fields.policyHash;
  delete fields.companyId;
  fields.companyId = decided.companyId;
  fields.status = decided.status || 'pending';
  fields.assignedAt = { _serverTimestamp: true };
  return { ok: true, fields, companyId: decided.companyId };
}
