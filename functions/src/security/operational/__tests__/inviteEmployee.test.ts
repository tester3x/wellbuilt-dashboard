import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluateInviteEmployee,
  parseInviteEmployeeRequest,
} from '../inviteEmployee';
import { COMPANY_ASSIGNABLE_USER_ROLES } from '../staffWriteUserRoles';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const COMPANY = 'liquid-gold';

describe('inviteEmployee request and tenant rules', () => {
  it('rejects caller company and unknown/owner roles', () => {
    expect(parseInviteEmployeeRequest({
      email: 'a@b.co',
      role: 'dispatch',
      companyId: COMPANY,
    })).toMatchObject({ ok: false, reason: 'caller_authority_field' });
    expect(parseInviteEmployeeRequest({ email: 'a@b.co', role: 'it' }))
      .toMatchObject({ ok: false, reason: 'role_not_assignable' });
    expect(parseInviteEmployeeRequest({ email: 'a@b.co', role: 'superuser' }))
      .toMatchObject({ ok: false, reason: 'unknown_role' });
    expect(parseInviteEmployeeRequest({ email: 'a@b.co', role: 'dispatch' }).ok).toBe(true);
    expect([...COMPANY_ASSIGNABLE_USER_ROLES]).not.toContain('it');
  });

  it('prevents cross-company overwrite and driver mismatch; replay is same-company', () => {
    expect(evaluateInviteEmployee({
      actingCompanyId: COMPANY,
      existingUser: { companyId: 'other-hauler' },
      driverCompanyId: null,
    })).toMatchObject({ ok: false, reason: 'cross_company' });
    expect(evaluateInviteEmployee({
      actingCompanyId: COMPANY,
      existingUser: null,
      driverCompanyId: 'other-hauler',
    })).toMatchObject({ ok: false, reason: 'cross_company' });
    expect(evaluateInviteEmployee({
      actingCompanyId: COMPANY,
      existingUser: { companyId: COMPANY, role: 'viewer' },
      driverCompanyId: COMPANY,
    })).toMatchObject({ ok: true, replay: true, companyId: COMPANY });
    expect(evaluateInviteEmployee({
      actingCompanyId: COMPANY,
      existingUser: null,
      driverCompanyId: null,
    })).toMatchObject({ ok: true, replay: false, companyId: COMPANY });
  });

  it('callable uses trusted manageRolesAndCapabilities and does not mint trusted authority', () => {
    const callable = readFileSync(join(ROOT, 'functions', 'src', 'security', 'inviteEmployeeCallable.ts'), 'utf8');
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_ROLES/);
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/trusted_staff_authority/);
    expect(callable).not.toMatch(/DEFAULT_ROLE_CAPABILITIES/);
    expect(callable).toMatch(/generatePasswordResetLink/);
    const index = readFileSync(join(ROOT, 'functions', 'src', 'index.ts'), 'utf8');
    expect(index).toMatch(/inviteEmployee/);
    expect(index).not.toMatch(/VALID_ROLES = \['driver'/);
    const tab = readFileSync(join(ROOT, 'src', 'components', 'admin', 'DriversTab.tsx'), 'utf8');
    const invite = tab.slice(tab.indexOf('const handleInviteSubmit'), tab.indexOf('const toggleDriverAdmin'));
    expect(invite).toMatch(/inviteEmployee/);
    expect(invite).not.toMatch(/companyId:/);
  });
});
