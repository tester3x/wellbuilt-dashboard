/**
 * Governed employee invitation. Company comes from trusted authority.
 * Does not mint trusted_staff_authority.
 */
import { fail, type StoreResult } from './jobPacketRevisionStore';
import { COMPANY_ASSIGNABLE_USER_ROLES } from './staffWriteUserRoles';

export const INVITE_EMPLOYEE_CALLABLE = 'inviteEmployee';
export const INVITE_REQUEST_KEYS = Object.freeze(['email', 'displayName', 'role', 'driverHash'] as const);
export const INVITE_FORBIDDEN_KEYS = Object.freeze([
  'companyId',
  'targetCompanyId',
  'uid',
  'roleCapabilities',
  'capabilities',
  'manageDrivers',
  'isPlatformAdmin',
  'wellbuiltAdmin',
  'platformAdmin',
] as const);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASSIGNABLE = new Set<string>(COMPANY_ASSIGNABLE_USER_ROLES);

export type InviteRequest = {
  email: string;
  displayName: string;
  role: string;
  driverHash: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function parseInviteEmployeeRequest(raw: unknown): StoreResult<InviteRequest> {
  if (!isPlainObject(raw)) return fail('record_must_be_object', 'request');
  for (const key of Object.getOwnPropertyNames(raw)) {
    if ((INVITE_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return fail('caller_authority_field', key);
    }
    if (!(INVITE_REQUEST_KEYS as readonly string[]).includes(key)) {
      return fail('unknown_field', key);
    }
  }
  if (typeof raw.email !== 'string') return fail('missing_field', 'email');
  const email = raw.email.trim().toLowerCase();
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) return fail('malformed_email', 'email');
  if (typeof raw.role !== 'string') return fail('missing_field', 'role');
  const role = raw.role.trim();
  if (!ASSIGNABLE.has(role)) {
    return fail(role === 'it' ? 'role_not_assignable' : 'unknown_role', 'role');
  }
  let displayName = '';
  if (raw.displayName !== undefined) {
    if (typeof raw.displayName !== 'string') return fail('malformed_displayName', 'displayName');
    displayName = raw.displayName.trim();
    if (displayName.length > 120) return fail('malformed_displayName', 'displayName');
  }
  let driverHash: string | null = null;
  if (raw.driverHash !== undefined && raw.driverHash !== null && raw.driverHash !== '') {
    if (typeof raw.driverHash !== 'string') return fail('malformed_driverHash', 'driverHash');
    const hash = raw.driverHash.trim();
    if (!hash || hash.length > 128 || hash.includes('/')) return fail('malformed_driverHash', 'driverHash');
    driverHash = hash;
  }
  return { ok: true, email, displayName, role, driverHash };
}

export function evaluateInviteEmployee(input: {
  actingCompanyId: string;
  existingUser: Record<string, unknown> | null;
  driverCompanyId: string | null;
}): StoreResult<{ companyId: string; replay: boolean }> {
  const acting = input.actingCompanyId.trim();
  if (!acting) return fail('missing_company', 'companyId');
  if (input.driverCompanyId && input.driverCompanyId !== acting) {
    return fail('cross_company', 'driverHash');
  }
  if (!input.existingUser) return { ok: true, companyId: acting, replay: false };
  const existingCompany = typeof input.existingUser.companyId === 'string'
    ? input.existingUser.companyId.trim()
    : '';
  if (existingCompany && existingCompany !== acting) {
    return fail('cross_company', 'email');
  }
  return { ok: true, companyId: acting, replay: !!existingCompany };
}
