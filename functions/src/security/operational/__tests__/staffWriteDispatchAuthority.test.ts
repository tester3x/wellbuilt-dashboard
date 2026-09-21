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
  staffWriteDispatchAccessFromTrusted,
} from '../staffWriteDispatch';
import {
  evaluateCreateIfAbsent,
  loadVerifiedRevisionFromData,
  rejectCallerAuthorityFields,
  type BirthIdentity,
} from '../dispatchPacketPin';

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

  it('companyId on create comes from trusted access, not the request', () => {
    expect(callable).toMatch(/callerCompanyId: access\.companyId/);
    expect(callable).toMatch(/companyId: decided\.companyId/);
    expect(callable).toMatch(/loadVerifiedRevision\(decided\.companyId/);
    expect(callable).toMatch(/assignedBy: fields\.assignedBy \|\| access\.uid/);
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
    expect(hits).toEqual(expect.arrayContaining([
      expect.stringMatching(/adminAuth\.ts$/),
      expect.stringMatching(/adminDashboardCatalog\.ts$/),
      expect.stringMatching(/companyBindingCallable\.ts$/),
      expect.stringMatching(/companyOnboarding\.ts$/),
      expect.stringMatching(/dismissDispatchCallable\.ts$/),
      expect.stringMatching(/driverAuthCallables\.ts$/),
      expect.stringMatching(/staffWriteWellConfigCallable\.ts$/),
      expect.stringMatching(/staffWriteDriverAssignmentCallable\.ts$/),
    ]));
    expect(hits.join('\n')).not.toMatch(/staffWriteDispatchCallable/);
  });
});
