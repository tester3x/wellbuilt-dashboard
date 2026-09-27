import { readFileSync } from 'fs';
import { join } from 'path';
import {
  COMPANY_ASSIGNABLE_USER_ROLES,
  parseUserRolesRequest,
  runStaffWriteUserRoles,
  USER_ROLES_FORBIDDEN_KEYS,
  type UserRolesStore,
} from '../staffWriteUserRoles';
import {
  decideTrustedCompanyCapability,
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
  TRUSTED_CAPABILITY_MANAGE_ROLES,
  TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
  TRUSTED_USER_ROLES,
  type TrustedCompanyAuthority,
} from '../../trustedStaffAuthority';

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
      request: { targetUid: UID, roles: ['admin'] },
      store,
    });
    expect(self).toMatchObject({ ok: false, reason: 'self_grant_forbidden' });
  });

  it('rejects it / owner and mixed forbidden roles without writing', async () => {
    const writes: unknown[] = [];
    const store = {
      async getUser() { writes.push('read'); return { companyId: COMPANY, role: 'dispatch' }; },
      async updateUser() { writes.push('write'); },
    };
    expect(parseUserRolesRequest({ targetUid: TARGET, roles: ['it'] })).toMatchObject({
      ok: false,
      reason: 'role_not_assignable',
    });
    expect(parseUserRolesRequest({ targetUid: TARGET, roles: ['dispatch', 'it'] })).toMatchObject({
      ok: false,
      reason: 'role_not_assignable',
    });
    const mixed = await runStaffWriteUserRoles({
      authority: authority(),
      request: { targetUid: TARGET, roles: ['admin', 'it'] },
      store,
    });
    expect(mixed).toMatchObject({ ok: false, reason: 'role_not_assignable' });
    expect(writes).toEqual([]);
  });

  it('company-assignable set is company-local and excludes it', () => {
    expect([...COMPANY_ASSIGNABLE_USER_ROLES]).toEqual([
      'driver', 'viewer', 'dispatch', 'payroll', 'safety', 'lead', 'manager', 'admin',
    ]);
    expect([...COMPANY_ASSIGNABLE_USER_ROLES]).not.toContain('it');
    expect([...TRUSTED_USER_ROLES]).toContain('it');
    expect(TRUSTED_CAPABILITY_MANAGE_ROLES).toBe('manageRolesAndCapabilities');
    expect(parseUserRolesRequest({ targetUid: TARGET, roles: ['admin'] }).ok).toBe(true);
    expect(parseUserRolesRequest({ targetUid: TARGET, roles: ['manager'] }).ok).toBe(true);
    expect(parseUserRolesRequest({ targetUid: TARGET, roles: ['driver'] }).ok).toBe(true);
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

  it('callable uses trusted manageRolesAndCapabilities and is exported', () => {
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteUserRolesCallable.ts'),
      'utf8',
    );
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_ROLES/);
    expect(callable).not.toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).not.toMatch(/manageDrivers/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/isPlatformAdmin/);
    expect(callable).not.toMatch(/roleCapabilities/);
    expect(callable).toMatch(/writeSecurityAudit/);
    const rolesIdx = callable.indexOf('TRUSTED_CAPABILITY_MANAGE_ROLES');
    const usersIdx = callable.indexOf('users/${uid}');
    expect(rolesIdx).toBeGreaterThan(-1);
    expect(usersIdx).toBeGreaterThan(rolesIdx);
    const sibling = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteRoleCapabilitiesCallable.ts'),
      'utf8',
    );
    expect(sibling).toMatch(/TRUSTED_CAPABILITY_MANAGE_ROLES/);
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

describe('staffWriteUserRoles collusion and escalation (production modules)', () => {
  function trustedRec(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
      uid: UID,
      companyId: COMPANY,
      active: true,
      capabilities: [TRUSTED_CAPABILITY_MANAGE_ROLES],
      ...over,
    };
  }

  function trackingStore(existing: Record<string, unknown> | null = {
    companyId: COMPANY, role: 'viewer', email: 'keep@x', displayName: 'Keep', status: 'active',
  }) {
    const reads: string[] = [];
    const writes: Record<string, unknown>[] = [];
    const store: UserRolesStore = {
      async getUser(uid: string) {
        reads.push(uid);
        return existing;
      },
      async updateUser(_uid: string, fields: Record<string, unknown>) {
        writes.push(fields);
      },
    };
    return { store, reads, writes };
  }

  async function decideWrite(
    authUid: string | undefined,
    rec: unknown,
    request: unknown,
    store: UserRolesStore,
  ) {
    const trusted = decideTrustedCompanyCapability(authUid, rec, TRUSTED_CAPABILITY_MANAGE_ROLES);
    if (!trusted.ok) return trusted;
    return runStaffWriteUserRoles({ authority: trusted, request, store });
  }

  it('1. trusted manageRolesAndCapabilities succeeds for an allowed company role', async () => {
    const { store, writes } = trackingStore();
    const r = await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['dispatch'] }, store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.companyId).toBe(COMPANY);
    expect(r.roles).toEqual(['dispatch']);
    expect(r.role).toBe('dispatch');
    expect(writes).toEqual([{ roles: ['dispatch'], role: 'dispatch' }]);
  });

  it('2. trusted manageDrivers without manageRolesAndCapabilities fails closed', async () => {
    const { store, reads, writes } = trackingStore();
    const r = await decideWrite(
      UID,
      trustedRec({ capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS] }),
      { targetUid: TARGET, roles: ['dispatch'] },
      store,
    );
    expect(r).toMatchObject({ ok: false, reason: 'missing_required_capability' });
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('3. manageDrivers plus forged RTDB admin/it role still fails', async () => {
    const { store, reads, writes } = trackingStore();
    const forgedRtdb = { role: 'it', roles: ['it', 'admin'], companyId: COMPANY };
    const r = await decideWrite(
      UID,
      trustedRec({ capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS] }),
      { targetUid: TARGET, roles: ['admin'] },
      store,
    );
    expect(r).toMatchObject({ ok: false, reason: 'missing_required_capability' });
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
    const helper = readFileSync(join(ROOT, 'functions', 'src', 'security', 'trustedStaffAuthority.ts'), 'utf8');
    expect(helper).not.toMatch(/admin\.database\(\)/);
    expect(helper).not.toMatch(/users\/\$\{/);
    void forgedRtdb;
  });

  it('4. manageDrivers plus forged auth-token capabilities still fails', async () => {
    const { store, writes } = trackingStore();
    await expect(requireTrustedCompanyCapability(UID, TRUSTED_CAPABILITY_MANAGE_ROLES, {
      getRecord: async () => trustedRec({ capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS] }),
    })).rejects.toMatchObject({ code: 'permission-denied' });
    const r = await decideWrite(
      UID,
      trustedRec({ capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS] }),
      { targetUid: TARGET, roles: ['manager'] },
      store,
    );
    expect(r).toMatchObject({ ok: false, reason: 'missing_required_capability' });
    expect(writes).toEqual([]);
    const helper = readFileSync(join(ROOT, 'functions', 'src', 'security', 'trustedStaffAuthority.ts'), 'utf8');
    expect(helper).not.toMatch(/token\./);
    expect(helper).not.toMatch(/authToken/);
    expect(helper).not.toMatch(/customClaims/);
  });

  it('5. manageDrivers plus companies.roleCapabilities override still fails', async () => {
    const { store, writes } = trackingStore();
    const r = await decideWrite(
      UID,
      trustedRec({ capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS] }),
      { targetUid: TARGET, roles: ['admin'] },
      store,
    );
    expect(r).toMatchObject({ ok: false, reason: 'missing_required_capability' });
    expect(writes).toEqual([]);
    const helper = readFileSync(join(ROOT, 'functions', 'src', 'security', 'trustedStaffAuthority.ts'), 'utf8');
    expect(helper).not.toMatch(/cSnap\.data\(\)\?\.roleCapabilities/);
    expect(helper).not.toMatch(/collection\('companies'\)/);
    const callable = readFileSync(join(ROOT, 'functions', 'src', 'security', 'staffWriteUserRolesCallable.ts'), 'utf8');
    expect(callable).not.toMatch(/roleCapabilities/);
  });

  it('6-9. missing, inactive, UID-mismatched, and malformed trusted records fail', async () => {
    const { store, reads, writes } = trackingStore();
    expect(await decideWrite(UID, null, { targetUid: TARGET, roles: ['dispatch'] }, store))
      .toMatchObject({ ok: false, reason: 'no_trusted_authority_record' });
    expect(await decideWrite(UID, trustedRec({ active: false }), { targetUid: TARGET, roles: ['dispatch'] }, store))
      .toMatchObject({ ok: false, reason: 'trusted_authority_inactive' });
    expect(await decideWrite(UID, trustedRec({ uid: 'other-uid' }), { targetUid: TARGET, roles: ['dispatch'] }, store))
      .toMatchObject({ ok: false, reason: 'trusted_authority_uid_mismatch' });
    expect((await decideWrite(UID, trustedRec({ extra: true }), { targetUid: TARGET, roles: ['dispatch'] }, store)).ok).toBe(false);
    expect((await decideWrite(UID, trustedRec({ schemaVersion: 2 }), { targetUid: TARGET, roles: ['dispatch'] }, store)).ok).toBe(false);
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('10-12. cross-company, self-target, and unknown role fail with zero writes', async () => {
    const cross = trackingStore({ companyId: 'other-hauler', role: 'dispatch' });
    expect(await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['manager'] }, cross.store))
      .toMatchObject({ ok: false, reason: 'cross_company' });
    expect(cross.writes).toEqual([]);
    const self = trackingStore();
    expect(await decideWrite(UID, trustedRec(), { targetUid: UID, roles: ['admin'] }, self.store))
      .toMatchObject({ ok: false, reason: 'self_grant_forbidden' });
    expect(self.writes).toEqual([]);
    const unknown = trackingStore();
    expect(await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['superuser'] }, unknown.store))
      .toMatchObject({ ok: false, reason: 'unknown_role' });
    expect(unknown.writes).toEqual([]);
    expect(unknown.reads).toEqual([]);
  });

  it('13-17. reserved/system/owner/it/viewAllCompanies/platform roles fail as not assignable or unknown', async () => {
    const { store, reads, writes } = trackingStore();
    expect(await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['it'] }, store))
      .toMatchObject({ ok: false, reason: 'role_not_assignable' });
    expect(await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['wellbuiltAdmin'] }, store))
      .toMatchObject({ ok: false, reason: 'unknown_role' });
    expect(await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['platformAdmin'] }, store))
      .toMatchObject({ ok: false, reason: 'unknown_role' });
    expect(await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['owner'] }, store))
      .toMatchObject({ ok: false, reason: 'unknown_role' });
    const auth = readFileSync(join(ROOT, 'src', 'lib', 'auth.ts'), 'utf8');
    const itBlock = auth.slice(auth.indexOf('  it: ['), auth.indexOf('  admin: ['));
    const adminBlock = auth.slice(auth.indexOf('  admin: ['), auth.indexOf('  manager: ['));
    expect(itBlock).toMatch(/viewAllCompanies/);
    expect(adminBlock).not.toMatch(/viewAllCompanies/);
    expect(adminBlock).not.toMatch(/manageRolesAndCapabilities/);
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('18-21. mixed forbidden rejects entirely; allowed write is role/roles only; primary is deterministic', async () => {
    const mixed = trackingStore();
    expect(await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['dispatch', 'it'] }, mixed.store))
      .toMatchObject({ ok: false, reason: 'role_not_assignable' });
    expect(mixed.reads).toEqual([]);
    expect(mixed.writes).toEqual([]);
    const ok = trackingStore();
    const r = await decideWrite(UID, trustedRec(), { targetUid: TARGET, roles: ['viewer', 'admin'] }, ok.store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe('admin');
    expect(ok.writes).toEqual([{ roles: ['viewer', 'admin'], role: 'admin' }]);
    expect(Object.keys(ok.writes[0])).toEqual(['roles', 'role']);
  });

  it('22. audit failure cannot create a false client failure after a committed write', () => {
    const callable = readFileSync(join(ROOT, 'functions', 'src', 'security', 'staffWriteUserRolesCallable.ts'), 'utf8');
    const outcomeIdx = callable.indexOf('if (!outcome.ok) throwFail(outcome)');
    const auditIdx = callable.indexOf('await writeSecurityAudit');
    const returnIdx = callable.indexOf('return {');
    expect(outcomeIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(outcomeIdx);
    expect(returnIdx).toBeGreaterThan(auditIdx);
    const audit = readFileSync(join(ROOT, 'functions', 'src', 'security', 'audit.ts'), 'utf8');
    expect(audit).toMatch(/non-fatal/);
    expect(audit).toMatch(/try \{/);
    expect(audit).toMatch(/catch \(err\)/);
  });

  it('former exploit: manageDrivers-only actor cannot assign admin/it/manager', async () => {
    const { store, reads, writes } = trackingStore();
    const rec = trustedRec({ capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS] });
    for (const roles of [['admin'], ['it'], ['manager']] as const) {
      const r = await decideWrite(UID, rec, { targetUid: TARGET, roles: [...roles] }, store);
      expect(r).toMatchObject({ ok: false, reason: 'missing_required_capability' });
    }
    await expect(requireTrustedCompanyCapability(UID, TRUSTED_CAPABILITY_MANAGE_ROLES, {
      getRecord: async () => rec,
    })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('roles-capable actor still cannot assign it / global owner role', async () => {
    const { store, reads, writes } = trackingStore();
    const rec = trustedRec();
    const allowed = await decideWrite(UID, rec, { targetUid: TARGET, roles: ['manager'] }, store);
    expect(allowed.ok).toBe(true);
    const denied = await decideWrite(UID, rec, { targetUid: TARGET, roles: ['it'] }, store);
    expect(denied).toMatchObject({ ok: false, reason: 'role_not_assignable' });
    expect(writes).toEqual([{ roles: ['manager'], role: 'manager' }]);
    expect(reads).toEqual([TARGET]);
  });
});
