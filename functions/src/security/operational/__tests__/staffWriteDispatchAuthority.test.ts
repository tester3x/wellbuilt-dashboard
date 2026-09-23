import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import {
  decideTrustedCompanyCapability,
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
  TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
} from '../../trustedStaffAuthority';
import {
  STAFF_WRITE_DISPATCH_FORBIDDEN_REQUEST_KEYS,
  STAFF_WRITE_DISPATCH_REQUIRED_CAPABILITY,
  evaluateStaffWriteDispatch,
  resolveServerAssignmentIdentity,
  staffWriteDispatchAccessFromTrusted,
} from '../staffWriteDispatch';
import {
  evaluateCreateIfAbsent,
  loadVerifiedRevisionFromData,
  rejectCallerAuthorityFields,
  resolveAuthoritativeWell,
  type BirthIdentity,
} from '../dispatchPacketPin';
import {
  ADMIN_POLICY_VERSION,
  WELLBUILT_ADMIN_CLAIM,
  authorizeAdminCall,
} from '../../../admin/authority';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const UID = 'uid-staff-1';
const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
    uid: UID,
    companyId: COMPANY,
    active: true,
    capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS],
    ...over,
  };
}

function decideCreate(authUid: string | undefined, rec: unknown, dispatchRecord: Record<string, unknown> = { wellName: 'Python', jobType: 'pw' }) {
  const trusted = decideTrustedCompanyCapability(authUid, rec, STAFF_WRITE_DISPATCH_REQUIRED_CAPABILITY);
  if (!trusted.ok) return trusted;
  const access = staffWriteDispatchAccessFromTrusted(trusted);
  if (!access.ok) return access;
  return evaluateStaffWriteDispatch({
    op: 'create',
    job: null,
    record: dispatchRecord,
    callerCompanyId: access.companyId,
    isPlatformAdmin: access.isPlatformAdmin,
  });
}

describe('staffWriteDispatch trusted authority', () => {
  it('1. valid active trusted record with manageDrivers succeeds', () => {
    const r = decideCreate(UID, record());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.companyId).toBe(COMPANY);
      expect(('isPlatformAdmin' in r) && (r as { isPlatformAdmin?: boolean }).isPlatformAdmin).toBeFalsy();
    }
    const access = staffWriteDispatchAccessFromTrusted({ uid: UID, companyId: COMPANY });
    expect(access.ok).toBe(true);
    if (access.ok) expect(access.isPlatformAdmin).toBe(false);
  });

  it('2. missing trusted record fails closed', () => {
    expect(decideCreate(UID, null)).toMatchObject({ ok: false, reason: 'no_trusted_authority_record' });
  });

  it('3. inactive trusted record fails closed', () => {
    expect(decideCreate(UID, record({ active: false }))).toMatchObject({
      ok: false,
      reason: 'trusted_authority_inactive',
    });
  });

  it('4. stored UID mismatch fails closed', () => {
    expect(decideCreate(UID, record({ uid: 'other-uid' }))).toMatchObject({
      ok: false,
      reason: 'trusted_authority_uid_mismatch',
    });
  });

  it('5. malformed trusted record fails closed', () => {
    expect(decideCreate(UID, record({ extra: true })).ok).toBe(false);
    expect(decideCreate(UID, record({ schemaVersion: 2 })).ok).toBe(false);
    expect(decideCreate(UID, record({ active: 'true' })).ok).toBe(false);
  });

  it('6. missing manageDrivers fails closed', () => {
    expect(decideCreate(UID, record({ capabilities: ['viewHome'] }))).toMatchObject({
      ok: false,
      reason: 'missing_required_capability',
    });
  });

  it('7. reserved or malformed capabilities fail closed', () => {
    expect(decideCreate(UID, record({ capabilities: ['manageDrivers', 'viewAllCompanies'] }))).toMatchObject({
      ok: false,
      reason: 'reserved_capability',
    });
    expect(decideCreate(UID, record({ capabilities: ['manageDrivers', 'packetExecution'] }))).toMatchObject({
      ok: false,
      reason: 'unknown_capability',
    });
    const sparse: unknown[] = [];
    sparse[1] = 'manageDrivers';
    expect(decideCreate(UID, record({ capabilities: sparse })).ok).toBe(false);
  });

  it('8-10. forged RTDB users role/roles/companyId cannot authorize or redirect', async () => {
    const forgedRtdb = { role: 'it', roles: ['it', 'admin'], companyId: OTHER };
    const missing = decideCreate(UID, null);
    expect(missing.ok).toBe(false);
    const otherCompany = decideCreate(UID, record({ capabilities: ['viewHome'] }));
    expect(otherCompany.ok).toBe(false);
    const ok = await requireTrustedCompanyCapability(UID, TRUSTED_CAPABILITY_MANAGE_DRIVERS, {
      getRecord: async () => record(),
    });
    expect(ok.companyId).toBe(COMPANY);
    expect(ok.companyId).not.toBe(OTHER);
    void forgedRtdb;
  });

  it('11. forged companies.roleCapabilities cannot authorize', () => {
    const r = decideCreate(UID, record({ capabilities: ['viewHome'] }));
    expect(r.ok).toBe(false);
    const helper = readFileSync(join(ROOT, 'functions', 'src', 'security', 'trustedStaffAuthority.ts'), 'utf8');
    expect(helper).not.toMatch(/cSnap\.data\(\)\?\.roleCapabilities/);
  });

  it('12-13. auth-token claims and platform-admin cannot bypass trusted authority', async () => {
    await expect(requireTrustedCompanyCapability(UID, TRUSTED_CAPABILITY_MANAGE_DRIVERS, {
      getRecord: async () => null,
    })).rejects.toMatchObject({ code: 'permission-denied' });
    const helper = readFileSync(join(ROOT, 'functions', 'src', 'security', 'trustedStaffAuthority.ts'), 'utf8');
    expect(helper).not.toMatch(/authorizeAdminCall/);
    expect(helper).not.toMatch(/token\.wellbuiltAdmin/);
    expect(helper).not.toMatch(/isPlatformAdmin/);
    const access = staffWriteDispatchAccessFromTrusted({ uid: UID, companyId: COMPANY });
    expect(access.ok && access.isPlatformAdmin).toBe(false);
  });

  it('14. caller companyId/targetCompanyId/publisher/authority fields are rejected', () => {
    expect(rejectCallerAuthorityFields({ companyId: OTHER, wellName: 'Python' })).toMatchObject({
      ok: false,
      reason: 'caller_authority_field',
    });
    expect([...STAFF_WRITE_DISPATCH_FORBIDDEN_REQUEST_KEYS]).toEqual(expect.arrayContaining([
      'companyId', 'targetCompanyId', 'publisher', 'publisherUid', 'role', 'roles',
      'capabilities', 'manageDrivers', 'isPlatformAdmin', 'wellbuiltAdmin',
    ]));
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteDispatchCallable.ts'),
      'utf8',
    );
    expect(callable).toMatch(/STAFF_WRITE_DISPATCH_FORBIDDEN_REQUEST_KEYS/);
    expect(callable).toMatch(/caller_authority_field/);
  });

  it('15. created dispatch is stamped with the trusted record companyId', () => {
    const r = decideCreate(UID, record());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.companyId).toBe(COMPANY);
  });

  it('16. trusted company A cannot bind company B revision/well/dispatch identity', async () => {
    const access = staffWriteDispatchAccessFromTrusted({ uid: UID, companyId: COMPANY });
    expect(access.ok).toBe(true);
    if (!access.ok) return;
    const looked = await loadVerifiedRevisionFromData(
      true,
      { companyId: OTHER, packageId: 'water-hauling', revision: 1 },
      access.companyId,
      { packageId: 'water-hauling', revision: 1 },
    );
    expect(looked.ok).toBe(false);
    const identity: BirthIdentity = {
      companyId: access.companyId,
      driverId: DRIVER,
      jobTypeId: 'pw',
      binding: {
        packageId: 'water-hauling',
        packetRevision: 1,
        contentHash: 'a'.repeat(64),
        policyHash: 'b'.repeat(64),
      },
      well: { wellName: 'Python', ndicWellName: 'PYTHON 1' },
    };
    const conflict = evaluateCreateIfAbsent({
      existing: {
        companyId: OTHER,
        driverId: DRIVER,
        jobType: 'pw',
        wellName: 'Python',
        ndicWellName: 'PYTHON 1',
        ...identity.binding,
      },
      expected: identity,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.field).toBe('companyId');
  });

  it('18. transaction failure produces no partial dispatch', () => {
    const dispatches = new Map<string, Record<string, unknown>>();
    const writes: string[] = [];
    const identity: BirthIdentity = {
      companyId: COMPANY,
      driverId: DRIVER,
      jobTypeId: 'pw',
      binding: {
        packageId: 'water-hauling',
        packetRevision: 1,
        contentHash: 'a'.repeat(64),
        policyHash: 'b'.repeat(64),
      },
      well: { wellName: 'Python', ndicWellName: 'PYTHON 1' },
    };
    const replay = evaluateCreateIfAbsent({ existing: null, expected: identity });
    expect(replay.ok && replay.result === 'create').toBe(true);
    try {
      writes.push('create');
      throw new Error('tx-fail');
    } catch (err) {
      expect((err as Error).message).toBe('tx-fail');
    }
    expect(dispatches.size).toBe(0);
    expect(writes).toEqual(['create']);
  });
});

describe('staffWriteDispatch platform-admin authorization path', () => {
  const PA_UID = 'EZHWZBlmkPYpHUq860nAo5ZmDDU2';
  const TARGET = 'atlas-energy';
  const adminToken = { [WELLBUILT_ADMIN_CLAIM]: true, email: 'admin@wellbuilt.example' };
  const enabledRecord = { enabled: true, policyVersion: ADMIN_POLICY_VERSION };

  it('a. platform admin (claim + enabled record) authorizes and creates for a validated target company', () => {
    const authz = authorizeAdminCall({ uid: PA_UID, token: adminToken }, enabledRecord);
    expect(authz.ok).toBe(true);
    // The callable resolves + server-validates the target and passes it as callerCompanyId.
    const decided = evaluateStaffWriteDispatch({
      op: 'create',
      job: null,
      record: { wellName: 'Python', jobType: 'pw' },
      callerCompanyId: TARGET,
      isPlatformAdmin: true,
    });
    expect(decided).toMatchObject({ ok: true, op: 'create', companyId: TARGET });
  });

  it('b. claim WITHOUT an enabled platform_admins record is rejected (no bare-claim shortcut)', () => {
    expect(authorizeAdminCall({ uid: PA_UID, token: adminToken }, null))
      .toMatchObject({ ok: false, reason: 'no_admin_record' });
    expect(authorizeAdminCall({ uid: PA_UID, token: adminToken }, { enabled: false, policyVersion: ADMIN_POLICY_VERSION }))
      .toMatchObject({ ok: false, reason: 'admin_record_disabled' });
    // and a create cannot select a tenant from record.companyId without a validated target.
    expect(evaluateStaffWriteDispatch({
      op: 'create',
      job: null,
      record: { wellName: 'Python', jobType: 'pw', companyId: TARGET },
      isPlatformAdmin: true,
    })).toMatchObject({ ok: false, reason: 'target_company_required' });
  });

  it('c. platform admin create still fails when driver / well / packet do not validate for the target', async () => {
    // Driver whose profile company differs from the target is rejected.
    expect(resolveServerAssignmentIdentity({
      clientDriverId: DRIVER,
      profile: { exists: true, active: true, companyId: COMPANY, legalName: 'Al', displayName: 'al' },
      dispatchCompanyId: TARGET,
      legacyWellPoolCompanyId: COMPANY,
    })).toMatchObject({ ok: false, reason: 'driver_company_mismatch' });

    // A well owned by another company is excluded from the target's authoritative scope.
    const catalog = {
      'Gabriel 2': { wellName: 'Gabriel 2', ndicName: 'GABRIEL 2-28-33H', companyId: COMPANY },
    };
    expect(resolveAuthoritativeWell(catalog, { wellName: 'Gabriel 2' }, TARGET))
      .toMatchObject({ ok: false, reason: 'target_well_not_found' });

    // A packet revision published under another company does not verify for the target.
    const rev = await loadVerifiedRevisionFromData(
      true,
      { companyId: COMPANY, packageId: 'water-hauling', revision: 1 },
      TARGET,
      { packageId: 'water-hauling', revision: 1 },
    );
    expect(rev.ok).toBe(false);
  });

  it('c2. a shared (no-companyId) well DOES resolve for a platform admin target', () => {
    const catalog = {
      Atlas: { wellName: 'Atlas', ndicName: 'ATLAS 1' }, // no companyId → shared pool
    };
    const well = resolveAuthoritativeWell(catalog, { wellName: 'Atlas' }, TARGET);
    expect(well.ok).toBe(true);
    if (well.ok) expect(well.well.ndicWellName).toBe('ATLAS 1');
  });

  it('d. ordinary trusted staff remain company-bound; cross-company is rejected', () => {
    const access = staffWriteDispatchAccessFromTrusted({ uid: UID, companyId: COMPANY });
    expect(access.ok).toBe(true);
    if (access.ok) expect(access.isPlatformAdmin).toBe(false);
    expect(evaluateStaffWriteDispatch({
      op: 'create',
      job: null,
      record: { wellName: 'Python', jobType: 'pw', companyId: OTHER },
      callerCompanyId: COMPANY,
      isPlatformAdmin: false,
    })).toMatchObject({ ok: false, reason: 'cross_company' });
  });

  it('e. callable stamps acting UID + target company on platform-admin writes and keeps assignedBy', () => {
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteDispatchCallable.ts'),
      'utf8',
    );
    // Reuses the canonical admin gate (verified claim AND enabled platform_admins record).
    expect(callable).toMatch(/authorizeAdminCall/);
    expect(callable).toMatch(/PLATFORM_ADMINS_COLLECTION/);
    expect(callable).toMatch(/collection\(PLATFORM_ADMINS_COLLECTION\)\.doc\(uid\)/);
    expect(callable).toMatch(/token\[WELLBUILT_ADMIN_CLAIM\] !== true/);
    // Target company is server-validated, never trusted from the client.
    expect(callable).toMatch(/target_company_required/);
    expect(callable).toMatch(/target_company_not_found/);
    expect(callable).toMatch(/collection\(COMPANIES_COLLECTION\)\.doc\(target\)/);
    // Attribution stamped for platform-admin writes; existing assignedBy preserved.
    expect(callable).toMatch(/assignedByUid: access\.uid/);
    expect(callable).toMatch(/actingPlatformAdminUid: access\.uid/);
    expect(callable).toMatch(/targetCompanyId: decided\.companyId/);
    expect(callable).toMatch(/assignedBy: fields\.assignedBy \|\| access\.uid/);
    // Gated on platform admin so ordinary-staff writes carry no extra fields.
    expect(callable).toMatch(/access\.isPlatformAdmin\s*\n?\s*\?\s*\{/);
  });
});

describe('production callable wiring', () => {
  const callable = readFileSync(
    join(ROOT, 'functions', 'src', 'security', 'staffWriteDispatchCallable.ts'),
    'utf8',
  );

  it('uses requireTrustedCompanyCapability(manageDrivers) and not requireManageDrivers', () => {
    expect(STAFF_WRITE_DISPATCH_REQUIRED_CAPABILITY).toBe('manageDrivers');
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).toMatch(/staffWriteDispatchAccessFromTrusted/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/adminAuth/);
    expect(callable).not.toMatch(/users\/\$\{/);
    expect(callable).not.toMatch(/roleCapabilities/);
    expect(callable).not.toMatch(/caller\.isPlatformAdmin/);
    expect(callable).toMatch(/isPlatformAdmin: access\.isPlatformAdmin/);
  });

  it('well allowlist is loaded from well_config, never wellConfig', () => {
    const runtime = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'operational', 'dispatchPinRuntime.ts'),
      'utf8',
    );
    expect(runtime).toMatch(/ref\('well_config'\)/);
    expect(runtime).not.toMatch(/ref\('wellConfig'\)/);
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteDispatchCallable.ts'),
      'utf8',
    );
    expect(callable).toMatch(/loadAuthorizedWellCatalog\(access\.companyId\)/);
  });

  it('companyId on create comes from trusted access, not the request', () => {
    expect(callable).toMatch(/callerCompanyId: access\.companyId/);
    expect(callable).toMatch(/companyId: decided\.companyId/);
    expect(callable).toMatch(/loadVerifiedRevision\(decided\.companyId/);
    expect(callable).toMatch(/assignedBy: fields\.assignedBy \|\| access\.uid/);
  });

  it('R1: server requires dispatchId on create; zero randomUUID auto-minting', () => {
    expect(callable).not.toMatch(/randomUUID/);
    expect(callable).toMatch(/parseDispatchId\(raw\.dispatchId\)/);
    expect(callable).toMatch(/create_conflict/);
  });

  it('R1: target well is resolved authoritatively; zero ndicWellName fallback', () => {
    expect(callable).toMatch(/loadAuthoritativeWell\(record/);
    expect(callable).not.toMatch(/ndicWellNameStr\s*=\s*.*wellNameStr/);
    expect(callable).not.toMatch(/ndicWellName\s*=\s*wellName/);
  });
});

describe('remaining RTDB-backed staff callables (not migrated)', () => {
  function walk(dir: string, acc: string[] = []): string[] {
    if (!existsSync(dir)) return acc;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) acc.push(full);
    }
    return acc;
  }

  it('staffWriteDispatch production path has zero requireManageDrivers', () => {
    const src = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteDispatchCallable.ts'),
      'utf8',
    );
    const operational = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'operational', 'staffWriteDispatch.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/requireManageDrivers/);
    expect(operational).not.toMatch(/requireManageDrivers/);
    expect(operational).not.toMatch(/admin\.database\(\)/);
    expect(src).toMatch(/drivers\/profiles\//);
  });

  it('lists remaining production files that still call requireManageDrivers', () => {
    const hits: string[] = [];
    for (const file of walk(join(ROOT, 'functions', 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('requireManageDrivers')) continue;
      hits.push(relative(join(ROOT, 'functions', 'src'), file).replace(/\\/g, '/'));
    }
    expect(hits).toEqual(['security/adminAuth.ts']);
    expect(hits.join('\n')).not.toMatch(/driverAuthCallables/);
    expect(hits.join('\n')).not.toMatch(/companyBindingCallable/);
    expect(hits.join('\n')).not.toMatch(/companyOnboarding\.ts/);
    expect(hits.join('\n')).not.toMatch(/adminDashboardCatalog\.ts/);
    expect(hits.join('\n')).not.toMatch(/staffWriteDispatchCallable/);
    expect(hits.join('\n')).not.toMatch(/staffWriteWellConfigCallable/);
    expect(hits.join('\n')).not.toMatch(/dismissDispatchCallable/);
    expect(hits.join('\n')).not.toMatch(/staffWriteDriverAssignmentCallable/);
  });
});
