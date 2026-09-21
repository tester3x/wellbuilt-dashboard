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

function trackingStore(approved: Record<string, unknown> | null = { companyId: COMPANY, active: true }) {
  const writes: { kind: string; path: string; fields?: Record<string, unknown> }[] = [];
  const store: RosterStore = {
    async getApproved() { return approved; },
    async getPending() { return { displayName: 'Pat', companyId: COMPANY, status: 'pending' }; },
    async updateApproved(path, fields) { writes.push({ kind: 'updateApproved', path, fields }); },
    async setApproved(path, fields) { writes.push({ kind: 'setApproved', path, fields }); },
    async removeApproved(path) { writes.push({ kind: 'removeApproved', path }); },
    async updatePending(path, fields) { writes.push({ kind: 'updatePending', path, fields }); },
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
});
