import { decideInviteEmployee } from '../inviteEmployeeDecision';
import { decideCompanyStaff, decidePlatformAdmin } from '../canonicalAdminAuthority';

const platform = decidePlatformAdmin({
  auth: { uid: 'plat', token: { wellbuiltAdmin: true } },
  platformAdminRecord: { enabled: true, policyVersion: 1 },
});
const managerA = decideCompanyStaff({
  uid: 'mgr',
  staff: { enabled: true, companyId: 'company-a', role: 'manager' },
});
const dispatchA = decideCompanyStaff({
  uid: 'dsp',
  staff: { enabled: true, companyId: 'company-a', role: 'dispatch' },
});

describe('decideInviteEmployee', () => {
  it('stamps company from authorized target when request omits it', () => {
    const r = decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: null,
      existingUserExists: false,
      driverHashProvided: false,
    });
    expect(r).toEqual({
      ok: true,
      stampCompanyId: 'company-a',
      rebind: false,
      existingClass: 'none',
    });
  });

  it('same-company invite is allowed for manager', () => {
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      existingUserExists: false,
      driverHashProvided: false,
    }).ok).toBe(true);
  });

  it('dispatch staff cannot invite', () => {
    expect(decideInviteEmployee({
      authority: dispatchA,
      requestedCompanyId: 'company-a',
      existingUserExists: false,
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'missing_manageDrivers' });
  });

  it('refuses a foreign Auth user for company staff', () => {
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      existingUserExists: true,
      existingUserCompanyId: 'company-b',
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'foreign_user' });
  });

  it('refuses a foreign driverHash for company staff', () => {
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      existingUserExists: false,
      driverHashProvided: true,
      driverCompanyId: 'company-b',
    })).toMatchObject({ ok: false, reason: 'foreign_driver' });
  });

  it('platform admin may rebind a foreign user only with explicitRebind', () => {
    expect(decideInviteEmployee({
      authority: platform,
      requestedCompanyId: 'company-a',
      requestedRole: 'viewer',
      existingUserExists: true,
      existingStaffCompanyId: 'company-b',
      existingRtdbCompanyId: 'company-b',
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'foreign_user' });
    expect(decideInviteEmployee({
      authority: platform,
      requestedCompanyId: 'company-a',
      requestedRole: 'viewer',
      existingUserExists: true,
      existingStaffCompanyId: 'company-b',
      existingRtdbCompanyId: 'company-b',
      explicitRebind: true,
      driverHashProvided: false,
    })).toEqual({
      ok: true,
      stampCompanyId: 'company-a',
      rebind: true,
      existingClass: 'foreign',
    });
  });

  it('refuses an unscoped existing Auth user for company staff', () => {
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      requestedRole: 'viewer',
      existingUserExists: true,
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'unscoped_existing_user' });
  });

  it('refuses an existing platform admin for company staff', () => {
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      requestedRole: 'viewer',
      existingUserExists: true,
      existingPlatformAdminRecordEnabled: true,
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'existing_platform_admin' });
  });

  it('refuses an existing driver identity for company staff', () => {
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      requestedRole: 'viewer',
      existingUserExists: true,
      existingDriverBound: true,
      existingDriverCompanyId: 'company-a',
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'existing_driver_identity' });
  });

  it('reuses a same-company canonical employee', () => {
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      requestedRole: 'viewer',
      existingUserExists: true,
      existingStaffCompanyId: 'company-a',
      existingRtdbCompanyId: 'company-a',
      existingClaimsCompanyId: 'company-a',
      driverHashProvided: false,
    })).toMatchObject({ ok: true, rebind: false, existingClass: 'same_company' });
  });

  it('manager cannot invite admin or it without manageRolesAndCapabilities', () => {
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      requestedRole: 'admin',
      existingUserExists: false,
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'role_above_authority' });
    expect(decideInviteEmployee({
      authority: managerA,
      requestedCompanyId: 'company-a',
      requestedRole: 'it',
      existingUserExists: false,
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'role_above_authority' });
  });

  it('omitted company is unscoped for platform without a request company', () => {
    expect(decideInviteEmployee({
      authority: platform,
      requestedCompanyId: null,
      existingUserExists: false,
      driverHashProvided: false,
    })).toMatchObject({ ok: false, reason: 'unscoped_target' });
  });
});
