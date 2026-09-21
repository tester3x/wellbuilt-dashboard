import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseUserRolesRequest,
  runStaffWriteUserRoles,
  USER_ROLES_FORBIDDEN_KEYS,
} from '../staffWriteUserRoles';
import type { TrustedCompanyAuthority } from '../../trustedStaffAuthority';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const UID = 'uid-staff-1';
const TARGET = 'uid-employee-2';
const COMPANY = 'liquid-gold';

function authority(): TrustedCompanyAuthority {
  return { uid: UID, companyId: COMPANY };
}

describe('staffWriteUserRoles', () => {
  it('rejects caller authority fields', () => {
    for (const key of USER_ROLES_FORBIDDEN_KEYS) {
      expect(parseUserRolesRequest({ targetUid: TARGET, roles: ['dispatch'], [key]: 'x' })).toMatchObject({
        ok: false,
        reason: 'caller_authority_field',
      });
    }
  });

  it('rejects unknown roles and self-grant', async () => {
    expect(parseUserRolesRequest({ targetUid: TARGET, roles: ['superuser'] })).toMatchObject({
      ok: false,
      reason: 'unknown_role',
    });
    const store = {
      async getUser() { return { companyId: COMPANY, role: 'dispatch' }; },
      async updateUser() { throw new Error('should not write'); },
    };
    const self = await runStaffWriteUserRoles({
      authority: authority(),
      request: { targetUid: UID, roles: ['it'] },
      store,
    });
    expect(self).toMatchObject({ ok: false, reason: 'self_grant_forbidden' });
  });

  it('writes only roles/role for the acting company', async () => {
    const writes: Record<string, unknown>[] = [];
    const store = {
      async getUser(uid: string) {
        if (uid !== TARGET) return null;
        return { companyId: COMPANY, role: 'viewer', email: 'a@b.c', displayName: 'Ann' };
      },
      async updateUser(_uid: string, fields: Record<string, unknown>) {
        writes.push(fields);
      },
    };
    const r = await runStaffWriteUserRoles({
      authority: authority(),
      request: { targetUid: TARGET, roles: ['dispatch', 'safety'] },
      store,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.companyId).toBe(COMPANY);
    expect(r.role).toBe('dispatch');
    expect(writes).toEqual([{ roles: ['dispatch', 'safety'], role: 'dispatch' }]);
  });

  it('cross-company target is rejected and writes nothing', async () => {
    const writes: unknown[] = [];
    const store = {
      async getUser() { return { companyId: 'other-hauler', role: 'dispatch' }; },
      async updateUser() { writes.push(1); },
    };
    const r = await runStaffWriteUserRoles({
      authority: authority(),
      request: { targetUid: TARGET, roles: ['manager'] },
      store,
    });
    expect(r).toMatchObject({ ok: false, reason: 'cross_company' });
    expect(writes).toEqual([]);
  });

  it('callable uses trusted manageDrivers and is exported', () => {
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteUserRolesCallable.ts'),
      'utf8',
    );
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/isPlatformAdmin/);
    expect(callable).toMatch(/writeSecurityAudit/);
    const root = readFileSync(join(ROOT, 'functions', 'src', 'index.ts'), 'utf8');
    expect(root).toMatch(/staffWriteUserRoles/);
    const audit = readFileSync(join(ROOT, 'functions', 'src', 'security', 'audit.ts'), 'utf8');
    expect(audit).toMatch(/non-fatal/);
  });

  it('missing user and unauthenticated fail closed without writes', async () => {
    const writes: unknown[] = [];
    const store = {
      async getUser() { return null; },
      async updateUser() { writes.push(1); },
    };
    const missing = await runStaffWriteUserRoles({
      authority: authority(),
      request: { targetUid: TARGET, roles: ['dispatch'] },
      store,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'user_not_found' });
    const unauth = await runStaffWriteUserRoles({
      authority: null,
      request: { targetUid: TARGET, roles: ['dispatch'] },
      store,
    });
    expect(unauth).toMatchObject({ ok: false, reason: 'unauthenticated' });
    expect(writes).toEqual([]);
  });

  it('unrelated target fields are not included in the write', async () => {
    const writes: Record<string, unknown>[] = [];
    const store = {
      async getUser() {
        return { companyId: COMPANY, role: 'viewer', email: 'keep@x', displayName: 'Keep', status: 'active' };
      },
      async updateUser(_uid: string, fields: Record<string, unknown>) {
        writes.push(fields);
      },
    };
    const r = await runStaffWriteUserRoles({
      authority: authority(),
      request: { targetUid: TARGET, roles: ['manager'] },
      store,
    });
    expect(r.ok).toBe(true);
    expect(writes).toEqual([{ roles: ['manager'], role: 'manager' }]);
    expect(Object.keys(writes[0])).toEqual(['roles', 'role']);
  });
});
