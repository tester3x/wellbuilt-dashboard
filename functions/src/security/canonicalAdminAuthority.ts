/**
 * Canonical admin-authority and target-authorization layer.
 *
 * Capability vocabulary and override semantics match Dashboard
 * `src/lib/auth.ts`. Company `roleCapabilities[role]` REPLACES the default
 * for that role. `staff.capabilities` never widens authority.
 *
 * Platform admin: verified `wellbuiltAdmin === true` claim AND an enabled
 * `platform_admins/{uid}` record. RTDB `users/{uid}` admin/it without a
 * company is NOT platform admin.
 */
import { authorizeAdminCall, type VerifiedCallerAuth } from '../admin/authority';

export type AdminClass = 'platform' | 'company_staff';

export type AdminAuthority =
  | {
      ok: true;
      class: AdminClass;
      uid: string;
      companyId: string | null;
      role: string | null;
      caps: string[];
    }
  | { ok: false; reason: string };

export interface StaffRecord {
  enabled?: unknown;
  companyId?: unknown;
  role?: unknown;
  capabilities?: unknown;
}

/**
 * Exact Dashboard capability names. Keep in lockstep with
 * `Dashboard/src/lib/auth.ts` Capability + DEFAULT_ROLE_CAPABILITIES.
 */
export const DEFAULT_ROLE_CAPABILITIES: Record<string, readonly string[]> = {
  it: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes',
    'viewEQuipment', 'manageEquipment', 'manageEquipmentAssignments',
    'viewDVIR', 'manageDVIR', 'viewEquipmentDocuments', 'manageEquipmentDocuments',
    'sendChat',
    'manageRolesAndCapabilities', 'viewAllCompanies', 'viewTruthDebug',
    'viewDiagnostics',
  ],
  admin: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes',
    'viewEQuipment', 'manageEquipment', 'manageEquipmentAssignments',
    'viewDVIR', 'manageDVIR', 'viewEquipmentDocuments', 'manageEquipmentDocuments',
    'sendChat',
  ],
  manager: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewPayroll',
    'viewDriverLogs', 'viewChat',
    'createDispatch', 'sendChat', 'manageDrivers', 'manageEquipmentAssignments',
    'viewEQuipment', 'viewDVIR', 'viewEquipmentDocuments',
  ],
  dispatch: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewChat',
    'createDispatch', 'sendChat', 'manageEquipmentAssignments',
    'viewEQuipment', 'viewDVIR', 'viewEquipmentDocuments',
  ],
  payroll: [
    'viewHome', 'viewBilling', 'viewPayroll', 'viewChat',
    'editBilling', 'approvePayroll', 'sendChat',
  ],
  viewer: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs',
    'viewEQuipment', 'viewDVIR', 'viewEquipmentDocuments',
  ],
  driver: [],
};

/** @deprecated Use DEFAULT_ROLE_CAPABILITIES. Kept as an alias for callers. */
export const DEFAULT_STAFF_CAPABILITIES = DEFAULT_ROLE_CAPABILITIES;

export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(
  Object.values(DEFAULT_ROLE_CAPABILITIES).flat(),
);

export function validateRoleCapabilities(raw: unknown): CompanyPolicyLoad {
  if (raw == null) return { status: 'defaults' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'unavailable', reason: 'policy_malformed' };
  }
  const overrides: Record<string, string[]> = {};
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      return { status: 'unavailable', reason: `policy_malformed_role:${role}` };
    }
    const caps: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || !KNOWN_CAPABILITIES.has(item)) {
        return { status: 'unavailable', reason: `policy_unknown_capability:${role}` };
      }
      caps.push(item);
    }
    overrides[role] = caps;
  }
  return { status: 'override', overrides };
}

export function resolveStaffCapabilities(
  staff: StaffRecord,
  companyRoleCapabilities?: Record<string, readonly string[] | string[]> | null,
): string[] {
  const role = typeof staff.role === 'string' ? staff.role : '';
  if (companyRoleCapabilities && Object.prototype.hasOwnProperty.call(companyRoleCapabilities, role)) {
    const override = companyRoleCapabilities[role];
    // Present role key: must already be a validated array. Never fall back.
    if (!Array.isArray(override)) return [];
    return [...override];
  }
  return [...(DEFAULT_ROLE_CAPABILITIES[role] ?? [])];
}

export function staffHasCapability(authority: AdminAuthority, cap: string): boolean {
  if (!authority.ok) return false;
  if (authority.class === 'platform') return true;
  return authority.caps.includes(cap);
}

export interface PlatformAdminRecord {
  enabled?: unknown;
  policyVersion?: unknown;
}

export function decidePlatformAdmin(input: {
  auth: VerifiedCallerAuth | null | undefined;
  platformAdminRecord: PlatformAdminRecord | null | undefined;
}): AdminAuthority {
  const authz = authorizeAdminCall(input.auth, input.platformAdminRecord as never);
  if (!authz.ok) return { ok: false, reason: authz.reason };
  return {
    ok: true,
    class: 'platform',
    uid: authz.actorUid,
    companyId: null,
    role: 'platform',
    caps: ['*'],
  };
}

export type CompanyPolicyLoad =
  | { status: 'defaults' }
  | { status: 'override'; overrides: Record<string, readonly string[] | string[]> }
  | { status: 'unavailable'; reason: string };

export function decideCompanyStaff(input: {
  uid: string;
  staff: StaffRecord | null | undefined;
  claimedCompanyId?: string | null;
  companyRoleCapabilities?: Record<string, readonly string[] | string[]> | null;
  companyPolicy?: CompanyPolicyLoad;
}): AdminAuthority {
  if (!input.uid) return { ok: false, reason: 'unauthenticated' };
  if (!input.staff) return { ok: false, reason: 'no_staff_record' };
  if (input.staff.enabled !== true) return { ok: false, reason: 'staff_disabled' };
  const companyId = typeof input.staff.companyId === 'string' ? input.staff.companyId.trim() : '';
  if (!companyId) return { ok: false, reason: 'staff_unscoped' };
  if (input.claimedCompanyId && input.claimedCompanyId !== companyId) {
    return { ok: false, reason: 'company_mismatch' };
  }
  const role = typeof input.staff.role === 'string' ? input.staff.role : '';
  if (!role) return { ok: false, reason: 'staff_role_missing' };
  if (input.companyPolicy?.status === 'unavailable') {
    return { ok: false, reason: input.companyPolicy.reason || 'policy_unavailable' };
  }
  const overrides = input.companyPolicy?.status === 'override'
    ? input.companyPolicy.overrides
    : input.companyRoleCapabilities;
  const caps = resolveStaffCapabilities(input.staff, overrides);
  return { ok: true, class: 'company_staff', uid: input.uid, companyId, role, caps };
}

/**
 * Resolve the caller's admin class. Platform wins only when both claim and
 * enabled record hold. Otherwise staff. RTDB role-only "global admin" is
 * never sufficient.
 */
export function decideAdminAuthority(input: {
  auth: VerifiedCallerAuth | null | undefined;
  platformAdminRecord: PlatformAdminRecord | null | undefined;
  staff: StaffRecord | null | undefined;
  companyRoleCapabilities?: Record<string, readonly string[] | string[]> | null;
  companyPolicy?: CompanyPolicyLoad;
}): AdminAuthority {
  const platform = decidePlatformAdmin({
    auth: input.auth,
    platformAdminRecord: input.platformAdminRecord,
  });
  if (platform.ok) return platform;
  const uid = input.auth?.uid ? String(input.auth.uid) : '';
  return decideCompanyStaff({
    uid,
    staff: input.staff,
    companyRoleCapabilities: input.companyRoleCapabilities,
    companyPolicy: input.companyPolicy,
  });
}

/**
 * Handler-level authority from injected reads. Present-but-malformed
 * roleCapabilities is policy_unavailable — never "use defaults."
 */
export function decideCanonicalAuthorityFromReads(input: {
  authUid: string;
  authToken?: Record<string, unknown> | null;
  platformAdmin: PlatformAdminRecord | null;
  staff: StaffRecord | null;
  companyExists?: boolean;
  roleCapabilities?: unknown;
  policyReadError?: string | null;
}): AdminAuthority {
  let companyPolicy: CompanyPolicyLoad = { status: 'defaults' };
  if (input.policyReadError) {
    companyPolicy = { status: 'unavailable', reason: input.policyReadError };
  } else if (input.companyExists === false) {
    companyPolicy = { status: 'defaults' };
  } else if (Object.prototype.hasOwnProperty.call(input, 'roleCapabilities')) {
    companyPolicy = validateRoleCapabilities(input.roleCapabilities);
  }
  return decideAdminAuthority({
    auth: { uid: input.authUid, token: input.authToken || {} },
    platformAdminRecord: input.platformAdmin,
    staff: input.staff,
    companyPolicy,
  });
}

export function authorizeTargetCompany(input: {
  authority: AdminAuthority;
  targetCompanyId?: string | null;
  userSuppliedCompanyId?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.authority.ok) return { ok: false, reason: input.authority.reason };
  if (input.userSuppliedCompanyId && input.authority.class !== 'platform') {
    if (input.userSuppliedCompanyId !== input.authority.companyId) {
      return { ok: false, reason: 'supplied_company_widens_authority' };
    }
  }
  if (input.authority.class === 'platform') return { ok: true };
  const target = (input.targetCompanyId || '').trim();
  if (!target) return { ok: false, reason: 'unscoped_target' };
  if (target !== input.authority.companyId) return { ok: false, reason: 'cross_tenant' };
  return { ok: true };
}

export function filterPendingForCaller<T extends { companyId?: string | null }>(
  rows: T[],
  authority: AdminAuthority,
): T[] {
  if (!authority.ok) return [];
  if (authority.class === 'platform') return rows;
  return rows.filter((r) => typeof r.companyId === 'string' && r.companyId === authority.companyId);
}

export function mayActOnUnscopedPending(authority: AdminAuthority): boolean {
  return authority.ok && authority.class === 'platform';
}
