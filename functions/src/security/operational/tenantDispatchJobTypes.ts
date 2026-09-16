/**
 * Server-authoritative validation and evaluation for tenant-scoped
 * dispatchJobTypes writes on companies/{companyId}.
 *
 * This module is pure and dependency-free (no direct database calls)
 * so the entire matrix is unit-testable without emulators.
 */

export const MAX_DISPATCH_JOB_TYPES = 50;
export const MAX_JOB_TYPE_NAME_LENGTH = 60;
export const MAX_JOB_TYPE_ID_LENGTH = 64;
export const MIN_JOB_TYPE_NAME_LENGTH = 1;
export const MIN_JOB_TYPE_ID_LENGTH = 1;

export type WorkClass = 'pw' | 'sw';

export interface DispatchJobTypeEntry {
  id: string;
  code: string;
  name: string;
  workClass: WorkClass;
  enabled: boolean;
  order: number;
}

export interface DispatchJobTypeConfig {
  version: 1;
  items: DispatchJobTypeEntry[];
  updatedAtIso?: string;
  updatedByUid?: string;
}

export interface TenantCaller {
  uid: string;
  roles: string[];
  companyId?: string | null;
  caps: string[];
  isPlatformAdmin: boolean;
  actorEmail?: string | null;
}

export type PayloadValidationResult =
  | { ok: true; payload: DispatchJobTypeConfig }
  | { ok: false; reason: string; field?: string };

export type CallerEvaluationResult =
  | { ok: true; targetCompanyId: string; isPlatformAdmin: boolean }
  | { ok: false; reason: string; field?: string };

const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const CODE_REGEX = /^[A-Z]{2}$/;

/**
 * Validates the complete dispatchJobTypes configuration payload.
 *
 * Rules:
 * - Version must be 1.
 * - Items must be an array of length 1..50.
 * - Each item:
 *   - id: non-empty string, length 1..64, alphanumeric/hyphen/underscore only. Unique across items.
 *   - code: exactly 2 uppercase letters [A-Z]{2}. Unique across items (case-insensitive).
 *   - name: trimmed non-empty string, length 1..60. Unique across items (case-insensitive).
 *   - workClass: strictly 'pw' or 'sw'.
 *   - enabled: strictly boolean.
 *   - order: non-negative integer.
 * - At least one item must have enabled === true.
 * - Normalized order: strictly 0..N-1 matching deterministic list order.
 */
export function validateDispatchJobTypesPayload(raw: unknown): PayloadValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'payload_must_be_object' };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    return { ok: false, reason: 'unsupported_version', field: 'version' };
  }

  if (!Array.isArray(obj.items)) {
    return { ok: false, reason: 'items_must_be_array', field: 'items' };
  }

  const items = obj.items;

  if (items.length === 0) {
    return { ok: false, reason: 'items_empty', field: 'items' };
  }

  if (items.length > MAX_DISPATCH_JOB_TYPES) {
    return { ok: false, reason: 'items_exceed_limit', field: 'items' };
  }

  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  const seenNames = new Set<string>();
  let enabledCount = 0;
  const validatedItems: DispatchJobTypeEntry[] = [];

  for (let i = 0; i < items.length; i++) {
    const rawItem = items[i];
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      return { ok: false, reason: 'item_must_be_object', field: `items[${i}]` };
    }

    const item = rawItem as Record<string, unknown>;

    // 1. Stable ID
    if (typeof item.id !== 'string') {
      return { ok: false, reason: 'invalid_id', field: `items[${i}].id` };
    }
    const id = item.id.trim();
    if (id.length < MIN_JOB_TYPE_ID_LENGTH || id.length > MAX_JOB_TYPE_ID_LENGTH) {
      return { ok: false, reason: 'id_length_out_of_bounds', field: `items[${i}].id` };
    }
    if (!ID_REGEX.test(id)) {
      return { ok: false, reason: 'id_invalid_characters', field: `items[${i}].id` };
    }
    if (seenIds.has(id)) {
      return { ok: false, reason: 'duplicate_id', field: id };
    }
    seenIds.add(id);

    // 2. Code (strictly 2 uppercase letters)
    if (typeof item.code !== 'string') {
      return { ok: false, reason: 'invalid_code', field: `items[${i}].code` };
    }
    const code = item.code.trim();
    if (!CODE_REGEX.test(code)) {
      return { ok: false, reason: 'code_must_be_two_uppercase_letters', field: `items[${i}].code` };
    }
    const upperCode = code.toUpperCase();
    if (seenCodes.has(upperCode)) {
      return { ok: false, reason: 'duplicate_code', field: code };
    }
    seenCodes.add(upperCode);

    // 3. Display Name
    if (typeof item.name !== 'string') {
      return { ok: false, reason: 'invalid_name', field: `items[${i}].name` };
    }
    const name = item.name.trim();
    if (name.length < MIN_JOB_TYPE_NAME_LENGTH || name.length > MAX_JOB_TYPE_NAME_LENGTH) {
      return { ok: false, reason: 'name_length_out_of_bounds', field: `items[${i}].name` };
    }
    const lowerName = name.toLowerCase();
    if (seenNames.has(lowerName)) {
      return { ok: false, reason: 'duplicate_name', field: name };
    }
    seenNames.add(lowerName);

    // 4. Work Class (strictly 'pw' or 'sw')
    if (item.workClass !== 'pw' && item.workClass !== 'sw') {
      return { ok: false, reason: 'invalid_work_class', field: `items[${i}].workClass` };
    }
    const workClass: WorkClass = item.workClass;

    // 5. Enabled (strictly boolean)
    if (typeof item.enabled !== 'boolean') {
      return { ok: false, reason: 'invalid_enabled', field: `items[${i}].enabled` };
    }
    if (item.enabled) {
      enabledCount++;
    }

    // 6. Order
    if (typeof item.order !== 'number' || !Number.isInteger(item.order) || item.order < 0) {
      return { ok: false, reason: 'invalid_order', field: `items[${i}].order` };
    }

    validatedItems.push({
      id,
      code,
      name,
      workClass,
      enabled: item.enabled,
      order: i, // deterministic integer ordering 0..N-1
    });
  }

  if (enabledCount === 0) {
    return { ok: false, reason: 'at_least_one_item_must_be_enabled', field: 'items' };
  }

  const payload: DispatchJobTypeConfig = {
    version: 1,
    items: validatedItems,
  };

  if (typeof obj.updatedAtIso === 'string') {
    payload.updatedAtIso = obj.updatedAtIso;
  }
  if (typeof obj.updatedByUid === 'string') {
    payload.updatedByUid = obj.updatedByUid;
  }

  return { ok: true, payload };
}

/**
 * Authoritatively evaluates caller access to target company.
 *
 * Rules:
 * - Unauthenticated callers are rejected.
 * - Platform admins (verified claim or unscoped IT/Admin) are explicitly allowed
 *   to configure any valid target company.
 * - Tenant callers can only target their own companyId (cross-company rejected).
 * - Tenant callers must have 'manageCompany' capability.
 */
export function evaluateTenantCallerAccess(
  caller: TenantCaller | null | undefined,
  targetCompanyId: string,
): CallerEvaluationResult {
  if (!caller || !caller.uid) {
    return { ok: false, reason: 'unauthenticated' };
  }

  const target = (targetCompanyId || '').trim();
  if (!target) {
    return { ok: false, reason: 'missing_target_company_id' };
  }

  if (caller.isPlatformAdmin) {
    return { ok: true, targetCompanyId: target, isPlatformAdmin: true };
  }

  const callerCompany = (caller.companyId || '').trim();
  if (!callerCompany) {
    return { ok: false, reason: 'caller_has_no_company' };
  }

  if (callerCompany !== target) {
    return { ok: false, reason: 'cross_company_target_denied', field: target };
  }

  if (!caller.caps.includes('manageCompany')) {
    return { ok: false, reason: 'lacks_manage_company_capability' };
  }

  return { ok: true, targetCompanyId: target, isPlatformAdmin: false };
}
