import {
  authorizeTargetCompany,
  decideAdminAuthority,
  decideCanonicalAuthorityFromReads,
  decideCompanyStaff,
  decidePlatformAdmin,
  filterPendingForCaller,
  mayActOnUnscopedPending,
  staffHasCapability,
  validateRoleCapabilities,
} from '../canonicalAdminAuthority';

const platformAuth = {
  uid: 'plat-1',
  token: { wellbuiltAdmin: true, email: 'mike@example.com' },
};
const enabledRecord = { enabled: true, policyVersion: 1 };

describe('canonical admin authority', () => {
  it('platform admin requires claim AND enabled record', () => {
    expect(decidePlatformAdmin({ auth: platformAuth, platformAdminRecord: enabledRecord }).ok).toBe(true);
    expect(decidePlatformAdmin({ auth: platformAuth, platformAdminRecord: { enabled: false, policyVersion: 1 } }).ok).toBe(false);
    expect(decidePlatformAdmin({
      auth: { uid: 'plat-1', token: { wellbuiltAdmin: false } },
      platformAdminRecord: enabledRecord,
    }).ok).toBe(false);
    expect(decidePlatformAdmin({
      auth: { uid: 'plat-1', token: {} },
      platformAdminRecord: enabledRecord,
    }).ok).toBe(false);
  });

  it('RTDB-looking global admin without claim+record is not platform admin', () => {
    const r = decideAdminAuthority({
      auth: { uid: 'rtdb-admin', token: { role: 'admin' } },
      platformAdminRecord: null,
      staff: null,
    });
    expect(r.ok).toBe(false);
  });

  it('company staff requires enabled record and exact company', () => {
    expect(decideCompanyStaff({
      uid: 'staff-a',
      staff: { enabled: true, companyId: 'liquid-gold', role: 'manager' },
    })).toMatchObject({ ok: true, class: 'company_staff', companyId: 'liquid-gold', caps: expect.arrayContaining(['manageDrivers']) });
    expect(decideCompanyStaff({
      uid: 'staff-a',
      staff: { enabled: false, companyId: 'liquid-gold' },
    }).ok).toBe(false);
    expect(decideCompanyStaff({
      uid: 'staff-a',
      staff: { enabled: true, companyId: '' },
    }).ok).toBe(false);
  });

  it('company A cannot act on company B', () => {
    const a = decideCompanyStaff({
      uid: 'staff-a',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
    });
    expect(authorizeTargetCompany({ authority: a, targetCompanyId: 'company-b' })).toMatchObject({
      ok: false,
      reason: 'cross_tenant',
    });
    expect(authorizeTargetCompany({ authority: a, targetCompanyId: 'company-a' }).ok).toBe(true);
    expect(authorizeTargetCompany({
      authority: a,
      targetCompanyId: 'company-a',
      userSuppliedCompanyId: 'company-b',
    }).ok).toBe(false);
  });

  it('unscoped pending rows are platform-admin only', () => {
    const staff = decideCompanyStaff({
      uid: 'staff-a',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
    });
    const platform = decidePlatformAdmin({ auth: platformAuth, platformAdminRecord: enabledRecord });
    expect(mayActOnUnscopedPending(staff)).toBe(false);
    expect(mayActOnUnscopedPending(platform)).toBe(true);
    const rows = [
      { pendingId: '1', companyId: 'company-a' },
      { pendingId: '2', companyId: 'company-b' },
      { pendingId: '3', companyId: null },
    ];
    expect(filterPendingForCaller(rows, staff).map((r) => r.pendingId)).toEqual(['1']);
    expect(filterPendingForCaller(rows, platform)).toHaveLength(3);
  });

  it('stale claim without enabled record is denied; revoked platform admin is denied', () => {
    expect(decideAdminAuthority({
      auth: platformAuth,
      platformAdminRecord: { enabled: false, policyVersion: 1 },
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
    })).toMatchObject({ ok: true, class: 'company_staff' });
    expect(decideAdminAuthority({
      auth: platformAuth,
      platformAdminRecord: { enabled: false, policyVersion: 1 },
      staff: null,
    }).ok).toBe(false);
  });

  it('enabled staff alone grants no capabilities for a driver role', () => {
    const staff = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'driver' },
    });
    expect(staff.ok).toBe(true);
    if (staff.ok) expect(staff.caps).toEqual([]);
    expect(staffHasCapability(staff, 'manageDrivers')).toBe(false);
    expect(staffHasCapability(staff, 'viewTruthDebug')).toBe(false);
  });

  it('handler injected malformed document denies manageDrivers', () => {
    const malformed = decideCanonicalAuthorityFromReads({
      authUid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      platformAdmin: null,
      companyExists: true,
      roleCapabilities: { manager: 'disabled' },
    });
    expect(malformed.ok).toBe(false);
    expect(malformed).toMatchObject({ reason: 'policy_malformed_role:manager' });
    expect(staffHasCapability(malformed, 'manageDrivers')).toBe(false);

    const unknown = decideCanonicalAuthorityFromReads({
      authUid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      platformAdmin: null,
      companyExists: true,
      roleCapabilities: { manager: ['manageDrivers', 'notARealCap'] },
    });
    expect(unknown.ok).toBe(false);
    expect(staffHasCapability(unknown, 'manageDrivers')).toBe(false);

    const empty = decideCanonicalAuthorityFromReads({
      authUid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      platformAdmin: null,
      companyExists: true,
      roleCapabilities: { manager: [] },
    });
    expect(empty.ok).toBe(true);
    expect(staffHasCapability(empty, 'manageDrivers')).toBe(false);

    const missingDoc = decideCanonicalAuthorityFromReads({
      authUid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      platformAdmin: null,
      companyExists: false,
    });
    expect(staffHasCapability(missingDoc, 'manageDrivers')).toBe(true);
  });

  it('malformed roleCapabilities never restore manageDrivers defaults', () => {
    expect(validateRoleCapabilities({ manager: 'disabled' })).toMatchObject({
      status: 'unavailable',
      reason: 'policy_malformed_role:manager',
    });
    expect(validateRoleCapabilities({ manager: ['notARealCap'] })).toMatchObject({
      status: 'unavailable',
    });
    const empty = validateRoleCapabilities({ manager: [] });
    expect(empty.status).toBe('override');
    const denied = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      companyPolicy: empty,
    });
    expect(staffHasCapability(denied, 'manageDrivers')).toBe(false);
    const malformed = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      companyPolicy: validateRoleCapabilities({ manager: 'disabled' }),
    });
    expect(malformed.ok).toBe(false);
    expect(staffHasCapability(malformed, 'manageDrivers')).toBe(false);
  });

  it('policy read failure does not restore defaults', () => {
    const denied = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      companyPolicy: { status: 'unavailable', reason: 'policy_read_failed' },
    });
    expect(denied).toMatchObject({ ok: false, reason: 'policy_read_failed' });
    expect(staffHasCapability(denied, 'manageDrivers')).toBe(false);
  });

  it('missing override uses defaults; present override replaces independently', () => {
    const missing = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      companyPolicy: { status: 'defaults' },
    });
    expect(staffHasCapability(missing, 'manageDrivers')).toBe(true);
    const replaced = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      companyPolicy: { status: 'override', overrides: { manager: ['viewHome'] } },
    });
    expect(staffHasCapability(replaced, 'manageDrivers')).toBe(false);
    expect(staffHasCapability(replaced, 'viewHome')).toBe(true);
  });

  it('company override replaces default and does not union', () => {
    const removed = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      companyRoleCapabilities: { manager: ['viewHome', 'viewDispatch'] },
    });
    expect(staffHasCapability(removed, 'manageDrivers')).toBe(false);
    expect(staffHasCapability(removed, 'viewHome')).toBe(true);
    const added = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'dispatch' },
      companyRoleCapabilities: { dispatch: ['viewHome', 'manageDrivers'] },
    });
    expect(staffHasCapability(added, 'manageDrivers')).toBe(true);
  });

  it('stale staff.capabilities cannot widen authority', () => {
    const staff = decideCompanyStaff({
      uid: 's',
      staff: {
        enabled: true,
        companyId: 'company-a',
        role: 'viewer',
        capabilities: ['manageDrivers', 'viewTruthDebug'],
      },
    });
    expect(staffHasCapability(staff, 'manageDrivers')).toBe(false);
    expect(staffHasCapability(staff, 'viewTruthDebug')).toBe(false);
  });

  it('truth endpoints use viewTruthDebug not viewTruth', () => {
    const itStaff = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'it' },
    });
    expect(staffHasCapability(itStaff, 'viewTruthDebug')).toBe(true);
    expect(staffHasCapability(itStaff, 'viewTruth')).toBe(false);
    const mgr = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
    });
    expect(staffHasCapability(mgr, 'viewTruthDebug')).toBe(false);
  });

  it('enabled staff is not automatically manageDrivers', () => {
    for (const role of ['dispatch', 'payroll', 'viewer']) {
      const staff = decideCompanyStaff({
        uid: 's',
        staff: { enabled: true, companyId: 'company-a', role },
      });
      expect(staff.ok).toBe(true);
      expect(staffHasCapability(staff, 'manageDrivers')).toBe(false);
    }
    expect(decideCompanyStaff({
      uid: 's',
      staff: { enabled: false, companyId: 'company-a', role: 'manager' },
    }).ok).toBe(false);
    expect(decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: '', role: 'manager' },
    }).ok).toBe(false);
    const cross = decideCompanyStaff({
      uid: 's',
      staff: { enabled: true, companyId: 'company-a', role: 'manager' },
      claimedCompanyId: 'company-b',
    });
    expect(cross.ok).toBe(false);
  });
});
