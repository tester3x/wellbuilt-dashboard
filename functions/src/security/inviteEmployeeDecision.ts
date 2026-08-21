/**
 * Pure inviteEmployee containment decisions.
 *
 * Company staff may reuse an existing Auth account only when canonical
 * records already prove that account belongs to the same company.
 * Unscoped, platform, driver, foreign, or ambiguous existing Auth users
 * are denied to company staff. Only a platform admin may perform an
 * explicit rebind — ordinary invite reuse is not a rebind.
 */
import {
  authorizeTargetCompany,
  staffHasCapability,
  type AdminAuthority,
} from './canonicalAdminAuthority';

export const PRIVILEGED_INVITE_ROLES = ['admin', 'it'] as const;

export type ExistingAuthClass =
  | 'none'
  | 'same_company'
  | 'foreign'
  | 'unscoped'
  | 'platform'
  | 'driver'
  | 'ambiguous';

export function classifyExistingAuthUser(input: {
  exists: boolean;
  staffCompanyId?: string | null;
  rtdbCompanyId?: string | null;
  claimsCompanyId?: string | null;
  stampCompanyId: string;
  platformAdminEnabled?: boolean;
  wellbuiltAdminClaim?: boolean;
  platformAdminRecordEnabled?: boolean;
  driverBound?: boolean;
  driverCompanyId?: string | null;
}): ExistingAuthClass {
  if (!input.exists) return 'none';

  const platform =
    input.platformAdminRecordEnabled === true
    || input.platformAdminEnabled === true
    || input.wellbuiltAdminClaim === true;
  if (platform) return 'platform';

  const staff = (input.staffCompanyId || '').trim();
  const rtdb = (input.rtdbCompanyId || '').trim();
  const claims = (input.claimsCompanyId || '').trim();
  const stamp = (input.stampCompanyId || '').trim();
  const companies = [staff, rtdb, claims].filter(Boolean);
  const unique = [...new Set(companies)];

  if (unique.length > 1) return 'ambiguous';
  if (unique.length === 1 && unique[0] !== stamp) return 'foreign';

  if (input.driverBound === true) {
    const dco = (input.driverCompanyId || '').trim();
    if (dco && dco !== stamp) return 'driver';
    if (!staff && !rtdb && !claims) return 'driver';
  }

  if (unique.length === 0) return 'unscoped';
  if (unique[0] === stamp) {
    // Same-company only when at least the staff record agrees. A lone
    // RTDB/claims hint without staff is not enough to adopt.
    if (staff === stamp) return 'same_company';
    return 'ambiguous';
  }
  return 'ambiguous';
}

export function decideInviteRoleCeiling(input: {
  authority: AdminAuthority;
  requestedRole?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  const role = (input.requestedRole || '').trim();
  if (!role) return { ok: true };
  if (!(PRIVILEGED_INVITE_ROLES as readonly string[]).includes(role)) {
    return { ok: true };
  }
  if (!input.authority.ok) return { ok: false, reason: input.authority.reason };
  if (input.authority.class === 'platform') return { ok: true };
  if (staffHasCapability(input.authority, 'manageRolesAndCapabilities')) {
    return { ok: true };
  }
  return { ok: false, reason: 'role_above_authority' };
}

export function decideInviteEmployee(input: {
  authority: AdminAuthority;
  requestedCompanyId?: string | null;
  requestedRole?: string | null;
  existingUserExists: boolean;
  existingUserCompanyId?: string | null;
  existingStaffCompanyId?: string | null;
  existingRtdbCompanyId?: string | null;
  existingClaimsCompanyId?: string | null;
  existingPlatformAdminEnabled?: boolean;
  existingWellbuiltAdminClaim?: boolean;
  existingPlatformAdminRecordEnabled?: boolean;
  existingDriverBound?: boolean;
  existingDriverCompanyId?: string | null;
  explicitRebind?: boolean;
  driverHashProvided: boolean;
  driverCompanyId?: string | null;
}):
  | { ok: true; stampCompanyId: string; rebind: boolean; existingClass: ExistingAuthClass }
  | { ok: false; reason: string } {
  if (!input.authority.ok) return { ok: false, reason: input.authority.reason };
  if (!staffHasCapability(input.authority, 'manageDrivers')) {
    return { ok: false, reason: 'missing_manageDrivers' };
  }
  const stamp =
    (input.requestedCompanyId || '').trim() ||
    (input.authority.companyId || '').trim();
  if (!stamp) return { ok: false, reason: 'unscoped_target' };
  const own = authorizeTargetCompany({
    authority: input.authority,
    targetCompanyId: stamp,
    userSuppliedCompanyId: input.requestedCompanyId || null,
  });
  if (!own.ok) return { ok: false, reason: own.reason };

  const ceiling = decideInviteRoleCeiling({
    authority: input.authority,
    requestedRole: input.requestedRole,
  });
  if (!ceiling.ok) return ceiling;

  if (input.driverHashProvided) {
    const dco = (input.driverCompanyId || '').trim();
    if (!dco) return { ok: false, reason: 'driver_unscoped' };
    if (dco !== stamp && input.authority.class !== 'platform') {
      return { ok: false, reason: 'foreign_driver' };
    }
  }

  const existingClass = classifyExistingAuthUser({
    exists: input.existingUserExists,
    staffCompanyId: input.existingStaffCompanyId ?? input.existingUserCompanyId,
    rtdbCompanyId: input.existingRtdbCompanyId ?? input.existingUserCompanyId,
    claimsCompanyId: input.existingClaimsCompanyId,
    stampCompanyId: stamp,
    platformAdminEnabled: input.existingPlatformAdminEnabled,
    wellbuiltAdminClaim: input.existingWellbuiltAdminClaim,
    platformAdminRecordEnabled: input.existingPlatformAdminRecordEnabled,
    driverBound: input.existingDriverBound,
    driverCompanyId: input.existingDriverCompanyId,
  });

  if (existingClass === 'none') {
    return { ok: true, stampCompanyId: stamp, rebind: false, existingClass };
  }

  if (existingClass === 'same_company') {
    return { ok: true, stampCompanyId: stamp, rebind: false, existingClass };
  }

  if (input.authority.class === 'platform' && input.explicitRebind === true) {
    return { ok: true, stampCompanyId: stamp, rebind: true, existingClass };
  }

  const reasons: Record<Exclude<ExistingAuthClass, 'none' | 'same_company'>, string> = {
    foreign: 'foreign_user',
    unscoped: 'unscoped_existing_user',
    platform: 'existing_platform_admin',
    driver: 'existing_driver_identity',
    ambiguous: 'ambiguous_existing_user',
  };
  return { ok: false, reason: reasons[existingClass] };
}
