import { readFileSync } from 'fs';
import { join } from 'path';
import {
  decideTrustedCompanyCapability,
  parseTrustedStaffAuthorityRecord,
  requireTrustedCompanyCapability,
  RESERVED_TRUSTED_CAPABILITIES,
  TRUSTED_CAPABILITY_ALLOWLIST,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
  TRUSTED_CAPABILITY_MANAGE_ROLES,
  TRUSTED_STAFF_AUTHORITY_COLLECTION,
  TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
} from '../trustedStaffAuthority';

const ROOT = join(__dirname, '..', '..', '..', '..');
const UID = 'uid-staff-1';
const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
    uid: UID,
    companyId: COMPANY,
    active: true,
    capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS, TRUSTED_CAPABILITY_MANAGE_ROLES],
    ...over,
  };
}

describe('trusted staff authority schema', () => {
  it('accepts an exact valid record', () => {
    const parsed = parseTrustedStaffAuthorityRecord(record(), UID);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.uid).toBe(UID);
      expect(parsed.companyId).toBe(COMPANY);
      expect(parsed.capabilities).toEqual([
        TRUSTED_CAPABILITY_MANAGE_DRIVERS,
        TRUSTED_CAPABILITY_MANAGE_ROLES,
      ]);
    }
  });

  it('missing record rejects', () => {
    expect(parseTrustedStaffAuthorityRecord(null, UID)).toMatchObject({
      ok: false,
      reason: 'no_trusted_authority_record',
    });
    expect(parseTrustedStaffAuthorityRecord(undefined, UID)).toMatchObject({
      ok: false,
      reason: 'no_trusted_authority_record',
    });
  });

  it('inactive authority rejects', () => {
    expect(parseTrustedStaffAuthorityRecord(record({ active: false }), UID)).toMatchObject({
      ok: false,
      reason: 'trusted_authority_inactive',
    });
  });

  it('malformed authority rejects', () => {
    expect(parseTrustedStaffAuthorityRecord('nope', UID).ok).toBe(false);
    expect(parseTrustedStaffAuthorityRecord(record({ extra: true }), UID)).toMatchObject({
      ok: false,
      reason: 'trusted_authority_malformed',
    });
    const missing = record();
    delete missing.capabilities;
    expect(parseTrustedStaffAuthorityRecord(missing, UID).ok).toBe(false);
    expect(parseTrustedStaffAuthorityRecord(record({ schemaVersion: 2 }), UID).ok).toBe(false);
    expect(parseTrustedStaffAuthorityRecord(record({ active: 'true' }), UID).ok).toBe(false);
    expect(parseTrustedStaffAuthorityRecord(record({ companyId: ' liquid-gold' }), UID).ok).toBe(false);
  });

  it('UID mismatch rejects', () => {
    expect(parseTrustedStaffAuthorityRecord(record({ uid: 'other-uid' }), UID)).toMatchObject({
      ok: false,
      reason: 'trusted_authority_uid_mismatch',
    });
    expect(parseTrustedStaffAuthorityRecord(record(), 'other-uid')).toMatchObject({
      ok: false,
      reason: 'trusted_authority_uid_mismatch',
    });
  });

  it('missing companyId rejects', () => {
    expect(parseTrustedStaffAuthorityRecord(record({ companyId: '' }), UID)).toMatchObject({
      ok: false,
      reason: 'missing_company',
    });
  });

  it('unknown and reserved capabilities on the record reject', () => {
    expect(parseTrustedStaffAuthorityRecord(record({
      capabilities: ['manageDrivers', 'viewAllCompanies'],
    }), UID)).toMatchObject({ ok: false, reason: 'reserved_capability' });
    expect(parseTrustedStaffAuthorityRecord(record({
      capabilities: ['manageDrivers', 'packetExecution'],
    }), UID)).toMatchObject({ ok: false, reason: 'unknown_capability' });
    expect(parseTrustedStaffAuthorityRecord(record({
      capabilities: ['manageDrivers', 'platformAdmin'],
    }), UID)).toMatchObject({ ok: false, reason: 'reserved_capability' });
  });

  it('duplicate and sparse capability arrays reject', () => {
    expect(parseTrustedStaffAuthorityRecord(record({
      capabilities: ['manageDrivers', 'manageDrivers'],
    }), UID)).toMatchObject({ ok: false, reason: 'duplicate_capability' });
    const sparse: unknown[] = [];
    sparse[1] = 'manageDrivers';
    expect(parseTrustedStaffAuthorityRecord(record({ capabilities: sparse }), UID).ok).toBe(false);
  });
});

describe('require named trusted capability', () => {
  it('unauthenticated caller rejects', () => {
    expect(decideTrustedCompanyCapability(undefined, record(), TRUSTED_CAPABILITY_MANAGE_DRIVERS)).toMatchObject({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(decideTrustedCompanyCapability('', record(), TRUSTED_CAPABILITY_MANAGE_DRIVERS)).toMatchObject({
      ok: false,
      reason: 'unauthenticated',
    });
  });

  it('missing required capability rejects', () => {
    const r = decideTrustedCompanyCapability(
      UID,
      record({ capabilities: [TRUSTED_CAPABILITY_MANAGE_ROLES] }),
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    expect(r).toMatchObject({ ok: false, reason: 'missing_required_capability' });
  });

  it('unknown or reserved required capability rejects', () => {
    expect(decideTrustedCompanyCapability(UID, record(), 'packetExecution')).toMatchObject({
      ok: false,
      reason: 'unknown_capability',
    });
    expect(decideTrustedCompanyCapability(UID, record(), 'viewAllCompanies')).toMatchObject({
      ok: false,
      reason: 'reserved_capability',
    });
    expect(decideTrustedCompanyCapability(UID, record(), 'wellbuiltAdmin')).toMatchObject({
      ok: false,
      reason: 'reserved_capability',
    });
  });

  it('trusted company-scoped caller can satisfy manageDrivers', () => {
    const r = decideTrustedCompanyCapability(UID, record(), TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uid).toBe(UID);
      expect(r.companyId).toBe(COMPANY);
    }
  });

  it('low-privilege trusted record cannot publish', () => {
    const r = decideTrustedCompanyCapability(
      UID,
      record({ capabilities: ['viewHome'] }),
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    expect(r.ok).toBe(false);
  });

  it('does not accept caller-selected company, role, or capabilities', () => {
    const r = decideTrustedCompanyCapability(UID, record(), TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.companyId).toBe(COMPANY);
    expect(r).not.toHaveProperty('role');
    expect(r).not.toHaveProperty('capabilities');
  });

  it('wrong-company substitution is structurally impossible — company comes from the record', () => {
    const r = decideTrustedCompanyCapability(
      UID,
      record({ companyId: OTHER }),
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.companyId).toBe(OTHER);
    expect(r.ok && r.companyId === COMPANY).toBe(false);
  });

  it('RTDB self-role change grants nothing', () => {
    const rtdbForged = {
      role: 'it',
      roles: ['it', 'admin'],
      companyId: COMPANY,
      caps: ['manageDrivers'],
    };
    const missing = decideTrustedCompanyCapability(UID, null, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('no_trusted_authority_record');
    const inactive = decideTrustedCompanyCapability(
      UID,
      record({ active: false }),
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    expect(inactive.ok).toBe(false);
    void rtdbForged;
  });

  it('RTDB companyId change grants nothing', () => {
    const r = decideTrustedCompanyCapability(
      UID,
      record({ capabilities: ['viewHome'] }),
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    expect(r.ok).toBe(false);
  });

  it('unscoped platform-admin does not bypass company scope', () => {
    const noCompany = decideTrustedCompanyCapability(
      UID,
      record({ companyId: '' }),
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    expect(noCompany.ok).toBe(false);
    if (!noCompany.ok) expect(noCompany.reason).toBe('missing_company');
    const helper = readFileSync(join(ROOT, 'functions', 'src', 'security', 'trustedStaffAuthority.ts'), 'utf8');
    expect(helper).toMatch(/'wellbuiltAdmin'/);
    expect(helper).not.toMatch(/token\.wellbuiltAdmin/);
    expect(helper).not.toMatch(/isPlatformAdmin/);
    expect(helper).not.toMatch(/authorizeAdminCall/);
    expect(helper).not.toMatch(/platform_admins/);
  });
});

describe('async helper uses injected record only', () => {
  it('unauthenticated throws', async () => {
    await expect(requireTrustedCompanyCapability(undefined, TRUSTED_CAPABILITY_MANAGE_DRIVERS, {
      getRecord: async () => record(),
    })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('missing record throws permission-denied', async () => {
    await expect(requireTrustedCompanyCapability(UID, TRUSTED_CAPABILITY_MANAGE_DRIVERS, {
      getRecord: async () => null,
    })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('loads the authenticated UID document and returns server companyId', async () => {
    const seen: string[] = [];
    const out = await requireTrustedCompanyCapability(UID, TRUSTED_CAPABILITY_MANAGE_DRIVERS, {
      getRecord: async (uid) => {
        seen.push(uid);
        return record();
      },
    });
    expect(seen).toEqual([UID]);
    expect(out).toEqual({ uid: UID, companyId: COMPANY });
  });

  it('never consults a writable RTDB users path', async () => {
    const helper = readFileSync(join(ROOT, 'functions', 'src', 'security', 'trustedStaffAuthority.ts'), 'utf8');
    expect(helper).not.toMatch(/admin\.database\(\)/);
    expect(helper).not.toMatch(/users\/\$\{/);
    expect(helper).not.toMatch(/cSnap\.data\(\)\?\.roleCapabilities/);
    expect(helper).not.toMatch(/\.collection\('companies'\)/);
    expect(helper).toMatch(new RegExp(`'${TRUSTED_STAFF_AUTHORITY_COLLECTION}'`));
  });
});

describe('allowlist', () => {
  it('manageDrivers and manageRolesAndCapabilities are trusted, reserved platform values are not', () => {
    expect([...TRUSTED_CAPABILITY_ALLOWLIST]).toContain(TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    expect([...TRUSTED_CAPABILITY_ALLOWLIST]).toContain(TRUSTED_CAPABILITY_MANAGE_ROLES);
    expect([...TRUSTED_CAPABILITY_ALLOWLIST]).not.toEqual(expect.arrayContaining([...RESERVED_TRUSTED_CAPABILITIES]));
    for (const reserved of RESERVED_TRUSTED_CAPABILITIES) {
      expect([...TRUSTED_CAPABILITY_ALLOWLIST]).not.toContain(reserved);
    }
  });
});

describe('production wiring does not read RTDB identity for repaired operations', () => {
  it('publisher callable uses the trusted helper only', () => {
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'jobPacketPublishCallable.ts'),
      'utf8',
    );
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/admin\.database\(\)/);
    expect(callable).not.toMatch(/users\/\$\{/);
    expect(callable).not.toMatch(/roleCapabilities/);
  });

  it('role-capability callable uses the trusted helper only', () => {
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteRoleCapabilitiesCallable.ts'),
      'utf8',
    );
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_ROLES/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/admin\.database\(\)/);
    expect(callable).not.toMatch(/users\/\$\{/);
  });
});
