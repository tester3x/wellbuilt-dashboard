import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseStaffWriteDriverRoster,
  runStaffWriteDriverRoster,
  type RosterStore,
} from '../staffWriteDriverRoster';
import {
  decideTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
  TRUSTED_CAPABILITY_MANAGE_ROLES,
  TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
} from '../../trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from '../staffWriteDispatch';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const UID = 'uid-staff-1';
const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const KEY = 'hash1';

function rec(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
    uid: UID,
    companyId: COMPANY,
    active: true,
    capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS],
    ...over,
  };
}

function trackingStore(
  approved: Record<string, unknown> | null = { companyId: COMPANY, active: true },
  pending: Record<string, unknown> | null = { displayName: 'Pat', companyId: COMPANY, status: 'pending' },
) {
  const writes: { kind: string; path?: string; driverId?: string; fields?: Record<string, unknown> }[] = [];
  const store: RosterStore = {
    async getApproved() { return approved; },
    async getPending() { return pending; },
    async updateApproved(path, fields) { writes.push({ kind: 'updateApproved', path, fields }); },
    async setApproved(path, fields) { writes.push({ kind: 'setApproved', path, fields }); },
    async removeApproved(path) { writes.push({ kind: 'removeApproved', path }); },
    async updatePending(path, fields) { writes.push({ kind: 'updatePending', path, fields }); },
    async setProfile(driverId, fields) { writes.push({ kind: 'setProfile', driverId, fields }); },
    async updateProfile(driverId, fields) { writes.push({ kind: 'updateProfile', driverId, fields }); },
  };
  return { store, writes };
}

describe('staffWriteDriverRoster', () => {
  it('19. trusted manageDrivers can toggle and approve', async () => {
    const { store, writes } = trackingStore();
    const parsed = parseStaffWriteDriverRoster({ op: 'toggleActive', approvedKey: KEY, active: false });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const trusted = decideTrustedCompanyCapability(UID, rec(), TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    expect(trusted.ok).toBe(true);
    if (!trusted.ok) return;
    const access = staffWriteDispatchAccessFromTrusted(trusted);
    expect(access.ok && access.isPlatformAdmin).toBe(false);
    if (!access.ok) return;
    const r = await runStaffWriteDriverRoster({
      actingCompanyId: access.companyId,
      actorUid: access.uid,
      request: parsed,
      store,
    });
    expect(r.ok).toBe(true);
    expect(writes).toEqual([{ kind: 'updateApproved', path: KEY, fields: { active: false } }]);
  });

  it('20-23. missing trusted, missing manageDrivers, and forged RTDB/token grant nothing', async () => {
    const { store, writes } = trackingStore();
    const parsed = parseStaffWriteDriverRoster({ op: 'toggleActive', approvedKey: KEY, active: false });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(decideTrustedCompanyCapability(UID, null, TRUSTED_CAPABILITY_MANAGE_DRIVERS))
      .toMatchObject({ ok: false, reason: 'no_trusted_authority_record' });
    expect(decideTrustedCompanyCapability(UID, rec({ active: false }), TRUSTED_CAPABILITY_MANAGE_DRIVERS))
      .toMatchObject({ ok: false, reason: 'trusted_authority_inactive' });
    expect(decideTrustedCompanyCapability(UID, rec({ extra: true }), TRUSTED_CAPABILITY_MANAGE_DRIVERS).ok).toBe(false);
    expect(decideTrustedCompanyCapability(
      UID,
      rec({ capabilities: [TRUSTED_CAPABILITY_MANAGE_ROLES] }),
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    )).toMatchObject({ ok: false, reason: 'missing_required_capability' });
    expect(writes).toEqual([]);
    const helper = readFileSync(join(ROOT, 'functions', 'src', 'security', 'trustedStaffAuthority.ts'), 'utf8');
    expect(helper).not.toMatch(/admin\.database\(\)/);
    expect(helper).not.toMatch(/customClaims/);
  });

  it('24-26. caller company rejected; cross-company target writes nothing', async () => {
    expect(parseStaffWriteDriverRoster({
      op: 'toggleActive',
      approvedKey: KEY,
      active: false,
      companyId: OTHER,
    })).toMatchObject({ ok: false, reason: 'caller_authority_field' });
    const { store, writes } = trackingStore({ companyId: OTHER, active: true });
    const parsed = parseStaffWriteDriverRoster({ op: 'toggleActive', approvedKey: KEY, active: false });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = await runStaffWriteDriverRoster({
      actingCompanyId: COMPANY,
      actorUid: UID,
      request: parsed,
      store,
    });
    expect(r).toMatchObject({ ok: false, reason: 'cross_company' });
    expect(writes).toEqual([]);
  });

  it('callable uses trusted manageDrivers; UI has no direct approved/pending mutation', () => {
    const callable = readFileSync(join(ROOT, 'functions', 'src', 'security', 'staffWriteDriverRosterCallable.ts'), 'utf8');
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).toMatch(/staffWriteDispatchAccessFromTrusted/);
    const tab = readFileSync(join(ROOT, 'src', 'components', 'admin', 'DriversTab.tsx'), 'utf8');
    expect(tab).toMatch(/staffWriteDriverRoster/);
    expect(tab).not.toMatch(/drivers\/approved\/\$\{/);
    expect(tab).not.toMatch(/drivers\/pending\/\$\{/);
    const companies = readFileSync(join(ROOT, 'src', 'components', 'admin', 'CompaniesTab.tsx'), 'utf8');
    expect(companies).not.toMatch(/drivers\/approved\/\$\{hash\}\/tier/);
  });

  it('approvePending stamps canonical driverId, writes canonical profile, and updates pending', async () => {
    const { store, writes } = trackingStore(null, {
      displayName: 'New Driver',
      legalName: 'New Driver Legal',
      companyId: COMPANY,
      status: 'pending',
    });
    const parsed = parseStaffWriteDriverRoster({
      op: 'approvePending',
      approvedKey: 'hash-abc-123',
      pendingKey: 'pending-xyz',
      displayName: 'New Driver',
      roles: ['driver'],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const r = await runStaffWriteDriverRoster({
      actingCompanyId: COMPANY,
      actorUid: UID,
      request: parsed,
      store,
    });
    expect(r.ok).toBe(true);

    // Verify approved write has canonical driverId (UUID with dashes)
    const setApprovedWrite = writes.find((w) => w.kind === 'setApproved');
    expect(setApprovedWrite).toBeDefined();
    const approvedPayload = setApprovedWrite?.fields as Record<string, unknown>;
    expect(approvedPayload.displayName).toBe('New Driver');
    expect(approvedPayload.companyId).toBe(COMPANY);
    expect(typeof approvedPayload.driverId).toBe('string');
    expect((approvedPayload.driverId as string).includes('-')).toBe(true);
    expect(approvedPayload.migratedToDriverId).toBe(approvedPayload.driverId);

    // Verify profile write was created with canonical UUID
    const setProfileWrite = writes.find((w) => w.kind === 'setProfile');
    expect(setProfileWrite).toBeDefined();
    expect(setProfileWrite?.driverId).toBe(approvedPayload.driverId);
    expect(setProfileWrite?.fields?.displayName).toBe('New Driver');
    expect(setProfileWrite?.fields?.companyId).toBe(COMPANY);

    // Verify pending status and driverId updated
    const updatePendingWrite = writes.find((w) => w.kind === 'updatePending');
    expect(updatePendingWrite).toBeDefined();
    expect(updatePendingWrite?.fields?.status).toBe('approved');
    expect(updatePendingWrite?.fields?.driverId).toBe(approvedPayload.driverId);
  });

  it('approvePending preserves existing canonical driverId if provided or present on pending', async () => {
    const existingCanonUuid = '44444444-5555-6666-7777-888888888888';
    const { store, writes } = trackingStore(null, {
      displayName: 'Secure Driver',
      companyId: COMPANY,
      status: 'pending',
      driverId: existingCanonUuid,
    });
    const parsed = parseStaffWriteDriverRoster({
      op: 'approvePending',
      approvedKey: 'hash-secure',
      pendingKey: 'pending-sec',
      driverId: existingCanonUuid,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const r = await runStaffWriteDriverRoster({
      actingCompanyId: COMPANY,
      actorUid: UID,
      request: parsed,
      store,
    });
    expect(r.ok).toBe(true);

    const setApprovedWrite = writes.find((w) => w.kind === 'setApproved');
    expect(setApprovedWrite?.fields?.driverId).toBe(existingCanonUuid);
    const setProfileWrite = writes.find((w) => w.kind === 'setProfile');
    expect(setProfileWrite?.driverId).toBe(existingCanonUuid);
  });

  it('toggleActive syncs active status to canonical profile when present', async () => {
    const canonUuid = '99999999-8888-7777-6666-555555555555';
    const { store, writes } = trackingStore({
      companyId: COMPANY,
      active: true,
      driverId: canonUuid,
    });
    const parsed = parseStaffWriteDriverRoster({
      op: 'toggleActive',
      approvedKey: 'hash-active',
      active: false,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const r = await runStaffWriteDriverRoster({
      actingCompanyId: COMPANY,
      actorUid: UID,
      request: parsed,
      store,
    });
    expect(r.ok).toBe(true);

    expect(writes).toEqual([
      { kind: 'updateProfile', driverId: canonUuid, fields: { active: false } },
      { kind: 'updateApproved', path: 'hash-active', fields: { active: false } },
    ]);
  });
});
