/**
 * Governed RTDB users/{uid} role assignment. Never trusts caller company.
 * Authority is requireTrustedCompanyCapability(manageRolesAndCapabilities).
 */
import { fail, type StoreResult } from './jobPacketRevisionStore';
import {
  TRUSTED_USER_ROLES,
  type TrustedCompanyAuthority,
} from '../trustedStaffAuthority';

export const STAFF_WRITE_USER_ROLES_CALLABLE = 'staffWriteUserRoles';

/**
 * Company-local roles this callable may write.
 *
 * Excluded: `it` — DEFAULT_ROLE_LABELS calls it Owner; onboarding
 * (adminApproveCompanyOnboarding) is the company-creator path; default
 * caps include viewAllCompanies / manageRolesAndCapabilities /
 * viewTruthDebug / viewDiagnostics (meta + cross-company).
 *
 * Included, from DEFAULT_ROLE_CAPABILITIES in src/lib/auth.ts:
 *   driver   — empty caps; WB-T/WB-S only; employee revoke target
 *   viewer   — company read surfaces, no manage*
 *   dispatch — company dispatch/equipment-assignment work
 *   payroll  — company billing/payroll
 *   safety   — company safety
 *   lead     — company safety lead
 *   manager  — company manageDrivers + assignments; no viewAllCompanies
 *   admin    — company operational superuser minus meta; no
 *              viewAllCompanies / manageRolesAndCapabilities /
 *              viewTruthDebug / viewDiagnostics
 */
export const COMPANY_ASSIGNABLE_USER_ROLES = Object.freeze([
  'driver',
  'viewer',
  'dispatch',
  'payroll',
  'safety',
  'lead',
  'manager',
  'admin',
] as const);

export const USER_ROLES_REQUEST_KEYS = Object.freeze(['targetUid', 'roles'] as const);

export const USER_ROLES_FORBIDDEN_KEYS = Object.freeze([
  'companyId',
  'targetCompanyId',
  'role',
  'capabilities',
  'uid',
  'publisherUid',
  'isPlatformAdmin',
  'wellbuiltAdmin',
  'manageDrivers',
] as const);

const CANONICAL_ROLE_SET = new Set<string>(TRUSTED_USER_ROLES);
const ASSIGNABLE_ROLE_SET = new Set<string>(COMPANY_ASSIGNABLE_USER_ROLES);
const ROLE_LEVELS: Record<string, number> = {
  driver: 1,
  viewer: 1,
  dispatch: 2,
  payroll: 2,
  safety: 2,
  lead: 3,
  manager: 3,
  admin: 4,
  it: 5,
};

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ROLES = COMPANY_ASSIGNABLE_USER_ROLES.length;

export type UserRolesStore = {
  getUser(uid: string): Promise<Record<string, unknown> | null>;
  updateUser(uid: string, fields: Record<string, unknown>): Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function primaryRole(roles: string[]): string {
  return roles.reduce((best, r) => (ROLE_LEVELS[r] > ROLE_LEVELS[best] ? r : best), roles[0]);
}

export function parseUserRolesRequest(raw: unknown): StoreResult<{
  targetUid: string;
  roles: string[];
}> {
  if (!isPlainObject(raw)) return fail('record_must_be_object', 'request');
  for (const key of Object.getOwnPropertyNames(raw)) {
    if ((USER_ROLES_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return fail('caller_authority_field', key);
    }
    if (!(USER_ROLES_REQUEST_KEYS as readonly string[]).includes(key)) {
      return fail('unknown_field', key);
    }
  }
  for (const required of USER_ROLES_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, required)) return fail('missing_field', required);
  }
  const targetUid = typeof raw.targetUid === 'string' ? raw.targetUid.trim() : '';
  if (!targetUid || !UID_RE.test(targetUid) || targetUid.includes('/')) {
    return fail('malformed_uid', 'targetUid');
  }
  if (!Array.isArray(raw.roles) || Object.getPrototypeOf(raw.roles) !== Array.prototype) {
    return fail('malformed_roles', 'roles');
  }
  if (raw.roles.length === 0 || raw.roles.length > MAX_ROLES) return fail('malformed_roles', 'roles');
  const descs = Object.getOwnPropertyDescriptors(raw.roles);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.roles.length; i++) {
    const d = descs[i];
    if (!d || d.get !== undefined || d.set !== undefined) return fail('malformed_roles', `roles[${i}]`);
    if (typeof d.value !== 'string') return fail('unknown_role', `roles[${i}]`);
    const role = d.value.trim();
    if (!CANONICAL_ROLE_SET.has(role)) return fail('unknown_role', `roles[${i}]`);
    if (!ASSIGNABLE_ROLE_SET.has(role)) return fail('role_not_assignable', `roles[${i}]`);
    if (seen.has(role)) return fail('duplicate_role', `roles[${i}]`);
    seen.add(role);
    out.push(role);
  }
  return { ok: true, targetUid, roles: out };
}

export async function runStaffWriteUserRoles(input: {
  authority: TrustedCompanyAuthority | null;
  request: unknown;
  store: UserRolesStore;
}): Promise<StoreResult<{ targetUid: string; companyId: string; roles: string[]; role: string }>> {
  if (!input.authority?.uid) return fail('unauthenticated');
  const companyId = typeof input.authority.companyId === 'string' ? input.authority.companyId.trim() : '';
  if (!companyId) return fail('missing_company', 'companyId');
  const parsed = parseUserRolesRequest(input.request);
  if (!parsed.ok) return parsed;
  if (parsed.targetUid === input.authority.uid) return fail('self_grant_forbidden', 'targetUid');
  const existing = await input.store.getUser(parsed.targetUid);
  if (!existing) return fail('user_not_found', 'targetUid');
  const targetCompany = typeof existing.companyId === 'string' ? existing.companyId.trim() : '';
  if (!targetCompany || targetCompany !== companyId) return fail('cross_company', 'targetUid');
  const role = primaryRole(parsed.roles);
  await input.store.updateUser(parsed.targetUid, { roles: parsed.roles, role });
  return { ok: true, targetUid: parsed.targetUid, companyId, roles: parsed.roles, role };
}
