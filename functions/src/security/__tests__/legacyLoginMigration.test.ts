import {
  CLASS1_PRESERVE_NAMES,
  CLASS2_MIGRATE_NAMES,
  decideAuthenticationPath,
  pickServerOwnedMetadata,
  assertLegacyRowUsable,
  preservationInvariants,
  assertPreservationInvariants,
  applyOneTimeLegacyMigration,
  class2SecureOnlyClientAllowed,
  type MigrationStores,
  type MigrationStep,
} from '../legacyLoginMigration';
import { legacySha256NamePasscode, normalizeDisplayName } from '../passcode';

const IPHONE_LEGACY = {
  displayName: 'iPhone16',
  active: true,
  isAdmin: true,
  companyId: 'liquid-gold',
  assignedRoutes: ['r1', 'r2', 'r3'],
  assignedCustomers: ['c1'],
  roles: ['admin'],
};

function memStores(over: {
  index?: { exists: boolean; driverId?: string };
  journal?: { exists: boolean; driverId?: string; status?: string };
  credExists?: boolean;
  legacy?: Record<string, unknown> | null;
} = {}) {
  const index = new Map<string, string>();
  const creds = new Map<string, Record<string, unknown>>();
  const journals = new Map<string, { driverId: string; status: string; nameNorm?: string }>();
  const rec = {
    profiles: [] as string[],
    disabled: [] as string[],
    auth: [] as string[],
    claims: [] as string[],
    credentials: [] as string[],
    indexes: [] as string[],
    journalWrites: [] as string[],
  };
  if (over.index?.exists && over.index.driverId) index.set('iphone16', over.index.driverId);
  if (over.journal?.exists && over.journal.driverId) {
    journals.set('j', {
      driverId: over.journal.driverId,
      status: over.journal.status || 'started',
    });
  }
  if (over.credExists && over.journal?.driverId) {
    creds.set(over.journal.driverId, { active: true });
  }

  const s: MigrationStores & typeof rec & { index: typeof index; journals: typeof journals } = {
    ...rec,
    index,
    journals,
    getNameIndex: async (nameNorm) => {
      if (index.has(nameNorm)) return { exists: true, driverId: index.get(nameNorm) };
      if (over.index && !journals.size) return over.index;
      return { exists: false };
    },
    getCredential: async (driverId) => {
      if (creds.has(driverId)) return { exists: true, data: creds.get(driverId) };
      return { exists: over.credExists === true && driverId === over.journal?.driverId, data: { active: true } };
    },
    getJournal: async (legacyHash) => {
      const hit = journals.get(legacyHash) || [...journals.values()][0];
      if (hit) return { exists: true, driverId: hit.driverId, status: hit.status, nameNorm: hit.nameNorm };
      return over.journal || { exists: false };
    },
    getLegacyApproved: async (legacyHash) => {
      const row = over.legacy === undefined ? IPHONE_LEGACY : over.legacy;
      if (!row) return null;
      const name = String(row.displayName || '');
      if (legacyHash !== legacySha256NamePasscode(name, 'secret99')) return null;
      return row;
    },
    claimJournal: async (legacyHash, nameNorm, driverId) => {
      const existingJ = journals.get(legacyHash);
      if (existingJ) return { driverId: existingJ.driverId, created: false };
      if (index.has(nameNorm) && index.get(nameNorm) !== driverId) {
        return { driverId: index.get(nameNorm) as string, created: false, nameTaken: true };
      }
      journals.set(legacyHash, { driverId, status: 'claimed', nameNorm });
      if (!index.has(nameNorm)) index.set(nameNorm, driverId);
      rec.journalWrites.push('started');
      return { driverId, created: true };
    },
    writeJournal: async (legacyHash, data) => {
      rec.journalWrites.push(String(data.status));
      journals.set(legacyHash, {
        driverId: String(data.driverId),
        status: String(data.status),
        nameNorm: data.nameNorm as string | undefined,
      });
    },
    writeCredential: async (driverId, data) => {
      rec.credentials.push(driverId);
      creds.set(driverId, data);
    },
    writeIndex: async (nameNorm, driverId) => {
      rec.indexes.push(nameNorm);
      index.set(nameNorm, driverId);
    },
    writeProfile: async (id) => {
      rec.profiles.push(id);
    },
    disableLegacyLogin: async (hash) => {
      rec.disabled.push(hash);
    },
    ensureAuthUser: async (id) => {
      rec.auth.push(id);
      return `driver_${id.replace(/-/g, '').slice(0, 28)}`;
    },
    setGlobalClaims: async (id) => {
      rec.claims.push(id);
    },
    nowMs: () => 1_700_000_000_000,
  };
  return s;
}

describe('legacy login migration decisions', () => {
  it('never migrates MikeS24 or Mikezfold', () => {
    for (const n of CLASS1_PRESERVE_NAMES) {
      const d = decideAuthenticationPath({
        nameNorm: n,
        modernIndexExists: false,
        modernCredentialActive: null,
      });
      expect(d.action).toBe('modern_only');
      expect(d).toMatchObject({ reason: 'class1_must_use_modern' });
    }
  });

  it('uses modern path when an index already exists', () => {
    const d = decideAuthenticationPath({
      nameNorm: 'tablets10',
      modernIndexExists: true,
      modernCredentialActive: true,
    });
    expect(d).toEqual({ action: 'modern_only', reason: 'index_present' });
  });

  it('fails closed when modern credential is inactive — no legacy fallback', () => {
    const d = decideAuthenticationPath({
      nameNorm: 'iphone16',
      modernIndexExists: true,
      modernCredentialActive: false,
    });
    expect(d).toEqual({ action: 'refuse', reason: 'modern_inactive' });
  });

  it('refuses names outside the five-driver allowlist', () => {
    for (const n of ['test auth', 'acmemike', 'aburger', 'lewfsd']) {
      const d = decideAuthenticationPath({
        nameNorm: n,
        modernIndexExists: false,
        modernCredentialActive: null,
      });
      expect(d).toEqual({ action: 'refuse', reason: 'not_allowlisted' });
    }
  });

  it('allows only the five Class-2 preserve names to migrate', () => {
    expect(CLASS2_MIGRATE_NAMES).toEqual([
      'tablets10',
      'iphone16',
      'adans',
      'marcial lebaron',
      'wisho-135',
    ]);
    for (const n of CLASS2_MIGRATE_NAMES) {
      const d = decideAuthenticationPath({
        nameNorm: n,
        modernIndexExists: false,
        modernCredentialActive: null,
      });
      expect(d.action).toBe('migrate');
    }
  });

  it('copies only server-owned metadata fields', () => {
    const picked = pickServerOwnedMetadata({
      displayName: 'iPhone16',
      isAdmin: true,
      companyId: 'liquid-gold',
      assignedRoutes: ['a', 'b', 'c'],
      assignedCustomers: ['x'],
      dashboardUid: 'uid-1',
      isAdminFromClient: true,
      rolesFromClient: ['god'],
      passcodeHash: 'should-not-copy',
    } as Record<string, unknown>);
    expect(picked.isAdmin).toBe(true);
    expect(picked.companyId).toBe('liquid-gold');
    expect(picked.assignedRoutes).toEqual(['a', 'b', 'c']);
    expect(picked).not.toHaveProperty('passcodeHash');
    expect(picked).not.toHaveProperty('isAdminFromClient');
    expect(picked).not.toHaveProperty('rolesFromClient');
  });

  it('rejects inactive or mismatched legacy rows', () => {
    expect(assertLegacyRowUsable('iPhone16', null).ok).toBe(false);
    expect(assertLegacyRowUsable('iPhone16', { displayName: 'iPhone16', active: false }).ok).toBe(false);
    expect(assertLegacyRowUsable('iPhone16', { displayName: 'AdanS', active: true }).ok).toBe(false);
    expect(assertLegacyRowUsable('iPhone16', { displayName: 'iPhone16', active: true }).ok).toBe(true);
  });

  it('encodes TabletS10 and iPhone16 preservation invariants', () => {
    const iphone = preservationInvariants('iPhone16', {
      displayName: 'iPhone16',
      isAdmin: true,
      companyId: 'liquid-gold',
      assignedRoutes: [1, 2, 3],
      assignedCustomers: [1],
      roles: ['admin'],
    });
    expect((iphone as Record<string, boolean>).requireAdmin).toBe(true);
    expect((iphone as Record<string, boolean>).requireCompanyLiquidGold).toBe(true);
    expect((iphone as Record<string, boolean>).requireRouteCount).toBe(true);
    expect((iphone as Record<string, boolean>).requireCustomerCount).toBe(true);
    const tab = preservationInvariants('TabletS10', {
      displayName: 'TabletS10',
      companyId: 'liquid-gold',
      dashboardUid: 'dash-1',
      dashboardRole: 'it',
    });
    expect((tab as Record<string, boolean>).requireDashboardUid).toBe(true);
    expect((tab as Record<string, boolean>).requireDashboardRole).toBe(true);
  });

  it('enforces invariants before mutation', () => {
    expect(
      assertPreservationInvariants('iPhone16', {
        displayName: 'iPhone16',
        isAdmin: false,
        companyId: 'liquid-gold',
        assignedRoutes: [1, 2, 3],
        assignedCustomers: [1],
      }).ok,
    ).toBe(false);
    expect(
      assertPreservationInvariants('TabletS10', {
        displayName: 'TabletS10',
        companyId: 'liquid-gold',
      }).ok,
    ).toBe(false);
    expect(
      assertPreservationInvariants('AdanS', {
        displayName: 'AdanS',
        companyId: 'liquid-gold',
      }).ok,
    ).toBe(true);
  });

  it('normalizes Wisho-135 independently of legalName', () => {
    expect(normalizeDisplayName('Wisho-135')).toBe('wisho-135');
    expect(normalizeDisplayName('Luiz Lebaron')).toBe('luiz lebaron');
  });

  it('forbids secure-only Class-2 clients until the migrator is authorized', () => {
    expect(class2SecureOnlyClientAllowed({ migrationAuthorizedAndAvailable: false })).toBe(false);
    expect(class2SecureOnlyClientAllowed({ migrationAuthorizedAndAvailable: true })).toBe(true);
  });
});

describe('applyOneTimeLegacyMigration journaled resume', () => {
  it('refuses when a completed modern index already exists', async () => {
    const s = memStores({ index: { exists: true, driverId: 'existing-uuid' }, credExists: true });
    const r = await applyOneTimeLegacyMigration(s, { displayName: 'iPhone16', passcode: 'secret99' });
    expect(r).toEqual({ ok: false, reason: 'modern_exists' });
    expect(s.profiles).toHaveLength(0);
    expect(s.disabled).toHaveLength(0);
  });

  it('fails closed on iPhone16/TabletS10 invariant miss before any write', async () => {
    const s = memStores({
      legacy: { displayName: 'iPhone16', active: true, companyId: 'wrong', isAdmin: false },
    });
    const r = await applyOneTimeLegacyMigration(s, { displayName: 'iPhone16', passcode: 'secret99' });
    expect(r).toEqual({ ok: false, reason: 'preservation_failed' });
    expect(s.credentials).toHaveLength(0);
    expect(s.profiles).toHaveLength(0);
    expect(s.indexes).toHaveLength(0);
  });

  it('does not disable legacy when the legacy row is inactive', async () => {
    const s = memStores({ legacy: { displayName: 'iPhone16', active: false } });
    const r = await applyOneTimeLegacyMigration(s, { displayName: 'iPhone16', passcode: 'secret99' });
    expect(r.ok).toBe(false);
    expect(s.disabled).toHaveLength(0);
  });

  const steps: MigrationStep[] = [
    'started',
    'credential_written',
    'profile_written',
    'auth_ensured',
    'claims_set',
    'index_written',
    'legacy_disabled',
  ];

  it('resumes after a failure at every migration step', async () => {
    for (const failAfter of steps) {
      const s = memStores();
      const first = await applyOneTimeLegacyMigration(s, {
        displayName: 'iPhone16',
        passcode: 'secret99',
        failAfter,
      });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.status).toBe(failAfter);
      if (failAfter !== 'legacy_disabled') {
        expect(s.disabled).toHaveLength(0);
      }
      const second = await applyOneTimeLegacyMigration(s, {
        displayName: 'iPhone16',
        passcode: 'secret99',
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.status).toBe('completed');
        expect(second.driverId).toBe((first as { driverId: string }).driverId);
        expect(second.reused).toBe(true);
      }
      expect(s.profiles.length).toBeGreaterThan(0);
      expect(s.auth.length).toBeGreaterThan(0);
      expect(s.claims.length).toBeGreaterThan(0);
      expect(s.indexes.length).toBeGreaterThan(0);
      expect(s.disabled).toHaveLength(1);
    }
  });

  it('does not return modern_exists for its own in-flight index', async () => {
    const s = memStores();
    const first = await applyOneTimeLegacyMigration(s, {
      displayName: 'iPhone16',
      passcode: 'secret99',
      failAfter: 'index_written',
    });
    expect(first.ok).toBe(true);
    const retry = await applyOneTimeLegacyMigration(s, {
      displayName: 'iPhone16',
      passcode: 'secret99',
    });
    expect(retry).toMatchObject({ ok: true, status: 'completed' });
    expect(s.disabled).toHaveLength(1);
  });
});

const REAL_SHAPES: Record<string, Record<string, unknown>> = {
  TabletS10: {
    displayName: 'TabletS10',
    active: true,
    companyId: 'liquid-gold',
    dashboardUid: 'dash-tablet-s10',
    dashboardRole: 'it',
  },
  iPhone16: {
    displayName: 'iPhone16',
    active: true,
    isAdmin: true,
    companyId: 'liquid-gold',
    assignedRoutes: ['lg-north', 'lg-mid', 'lg-south'],
    assignedCustomers: ['liquid-gold-1'],
    roles: ['admin'],
  },
  AdanS: {
    displayName: 'AdanS',
    active: true,
    companyId: 'liquid-gold',
  },
  'Marcial Lebaron': {
    displayName: 'Marcial Lebaron',
    active: true,
    companyId: 'liquid-gold',
  },
  'Wisho-135': {
    displayName: 'Wisho-135',
    legalName: 'Luiz Lebaron',
    active: true,
    companyId: 'liquid-gold',
  },
};

describe('real-shape Class-2 fixtures and Class-1 refuse', () => {
  it('migrates ordinary drivers without inventing a required roles array', async () => {
    for (const [name, legacy] of Object.entries(REAL_SHAPES)) {
      const s = memStores({ legacy });
      const r = await applyOneTimeLegacyMigration(s, { displayName: name, passcode: 'secret99' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe('completed');
    }
  });

  it('assigns server driver role when the legacy row has no roles', async () => {
    const s = memStores({ legacy: REAL_SHAPES.AdanS });
    const r = await applyOneTimeLegacyMigration(s, { displayName: 'AdanS', passcode: 'secret99' });
    expect(r.ok).toBe(true);
    expect(s.claims).toHaveLength(1);
  });

  it('refuses MikeS24 and Mikezfold and writes nothing', async () => {
    for (const name of ['MikeS24', 'Mikezfold']) {
      const s = memStores({
        legacy: { displayName: name, active: true, companyId: 'liquid-gold' },
      });
      const r = await applyOneTimeLegacyMigration(s, { displayName: name, passcode: 'secret99' });
      expect(r).toEqual({ ok: false, reason: 'class1_must_use_modern' });
      expect(s.credentials).toHaveLength(0);
      expect(s.profiles).toHaveLength(0);
      expect(s.indexes).toHaveLength(0);
    }
  });

  it('converges two simultaneous correct-passcode claims on one UUID', async () => {
    const s = memStores({ legacy: REAL_SHAPES.AdanS });
    const [a, b] = await Promise.all([
      applyOneTimeLegacyMigration(s, { displayName: 'AdanS', passcode: 'secret99' }),
      applyOneTimeLegacyMigration(s, { displayName: 'AdanS', passcode: 'secret99' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.driverId).toBe(b.driverId);
    expect(new Set(s.indexes).size).toBe(1);
  });

  it('does not reserve the name for an incorrect passcode racing a correct one', async () => {
    const s = memStores({ legacy: REAL_SHAPES.AdanS });
    const [wrong, right] = await Promise.all([
      applyOneTimeLegacyMigration(s, { displayName: 'AdanS', passcode: 'wrong-pass' }),
      applyOneTimeLegacyMigration(s, { displayName: 'AdanS', passcode: 'secret99' }),
    ]);
    expect(wrong.ok).toBe(false);
    expect(right.ok).toBe(true);
  });
});
