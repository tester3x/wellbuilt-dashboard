import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseRoleEditorRequest,
  runStaffWriteRoleCapabilities,
  ROLE_EDITOR_FORBIDDEN_KEYS,
  STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE,
  type RoleEditorStoreTx,
} from '../staffWriteRoleCapabilities';
import {
  TRUSTED_CAPABILITY_MANAGE_ROLES,
  type TrustedCompanyAuthority,
} from '../../trustedStaffAuthority';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const UID = 'uid-staff-1';

function authority(over: Partial<TrustedCompanyAuthority> = {}): TrustedCompanyAuthority {
  return { uid: UID, companyId: COMPANY, ...over };
}

function req(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roleLabels: { dispatch: 'Coordinator' },
    roleCapabilities: { dispatch: ['viewHome', 'createDispatch'] },
    ...over,
  };
}

class MemoryRoleStore implements RoleEditorStoreTx {
  companies = new Map<string, Record<string, unknown>>();
  writes: string[] = [];
  failNext: string | null = null;
  async getCompany(companyId: string) {
    const v = this.companies.get(companyId);
    return v ? { ...v } : null;
  }
  updateCompany(companyId: string, fields: Record<string, unknown>) {
    if (this.failNext === 'updateCompany') throw new Error('tx-fail');
    const current = this.companies.get(companyId);
    if (!current) throw new Error('not-found');
    this.companies.set(companyId, { ...current, ...fields });
    this.writes.push(companyId);
  }
}

describe('request allowlist', () => {
  it('rejects every authority field in caller input', () => {
    for (const key of ROLE_EDITOR_FORBIDDEN_KEYS) {
      const r = parseRoleEditorRequest(req({ [key]: key === 'capabilities' ? ['manageDrivers'] : 'x' }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('caller_authority_field');
    }
  });

  it('unknown extra field rejects', () => {
    expect(parseRoleEditorRequest(req({ extra: true }))).toMatchObject({
      ok: false,
      reason: 'unknown_field',
    });
  });

  it('missing required fields reject', () => {
    expect(parseRoleEditorRequest({ roleLabels: {} })).toMatchObject({
      ok: false,
      reason: 'missing_field',
    });
    expect(parseRoleEditorRequest({ roleCapabilities: {} })).toMatchObject({
      ok: false,
      reason: 'missing_field',
    });
  });

  it('unknown role rejects', () => {
    expect(parseRoleEditorRequest(req({
      roleCapabilities: { superuser: ['viewHome'] },
    }))).toMatchObject({ ok: false, reason: 'unknown_role' });
    expect(parseRoleEditorRequest(req({
      roleLabels: { owner: 'Owner' },
    }))).toMatchObject({ ok: false, reason: 'unknown_role' });
  });

  it('unknown and reserved capabilities reject', () => {
    expect(parseRoleEditorRequest(req({
      roleCapabilities: { dispatch: ['packetExecution'] },
    }))).toMatchObject({ ok: false, reason: 'unknown_capability' });
    expect(parseRoleEditorRequest(req({
      roleCapabilities: { it: ['viewAllCompanies'] },
    }))).toMatchObject({ ok: false, reason: 'reserved_capability' });
    expect(parseRoleEditorRequest(req({
      roleCapabilities: { it: ['wellbuiltAdmin'] },
    }))).toMatchObject({ ok: false, reason: 'reserved_capability' });
  });

  it('duplicate capability rejects', () => {
    expect(parseRoleEditorRequest(req({
      roleCapabilities: { dispatch: ['viewHome', 'viewHome'] },
    }))).toMatchObject({ ok: false, reason: 'duplicate_capability' });
  });

  it('sparse arrays, accessors, and non-plain objects reject', () => {
    const sparse: unknown[] = [];
    sparse[1] = 'viewHome';
    expect(parseRoleEditorRequest(req({
      roleCapabilities: { dispatch: sparse },
    })).ok).toBe(false);
    expect(parseRoleEditorRequest(req({
      roleCapabilities: Object.create({ dispatch: ['viewHome'] }),
    })).ok).toBe(false);
    expect(parseRoleEditorRequest(null).ok).toBe(false);
  });

  it('canonicalizes deterministically', () => {
    const r = parseRoleEditorRequest({
      roleCapabilities: { manager: ['createDispatch', 'viewHome'], dispatch: ['viewHome'] },
      roleLabels: { manager: 'Lead Mgr', dispatch: 'Coordinator' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.roleLabels)).toEqual(['dispatch', 'manager']);
    expect(r.roleCapabilities.manager).toEqual(['createDispatch', 'viewHome']);
  });
});

describe('write transaction', () => {
  it('cross-company request is structurally impossible — no targetCompanyId', () => {
    const r = parseRoleEditorRequest(req({ targetCompanyId: OTHER }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('caller_authority_field');
  });

  it('trusted request updates only the authenticated company', async () => {
    const store = new MemoryRoleStore();
    store.companies.set(COMPANY, { name: 'Liquid Gold', rateSheets: { default: 1 } });
    store.companies.set(OTHER, { name: 'Other', roleCapabilities: { viewer: ['viewHome'] } });
    const r = await runStaffWriteRoleCapabilities({
      authority: authority(),
      request: req(),
      store,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.companyId).toBe(COMPANY);
    expect(store.writes).toEqual([COMPANY]);
    expect(store.companies.get(OTHER)).toEqual({
      name: 'Other',
      roleCapabilities: { viewer: ['viewHome'] },
    });
  });

  it('unrelated company fields remain unchanged', async () => {
    const store = new MemoryRoleStore();
    store.companies.set(COMPANY, {
      name: 'Liquid Gold',
      invoicePrefix: 'LG',
      wellbuiltContract: { planId: 'plan-field' },
      rateSheets: { default: 1 },
    });
    const r = await runStaffWriteRoleCapabilities({
      authority: authority(),
      request: req(),
      store,
    });
    expect(r.ok).toBe(true);
    const after = store.companies.get(COMPANY)!;
    expect(after.name).toBe('Liquid Gold');
    expect(after.invoicePrefix).toBe('LG');
    expect(after.wellbuiltContract).toEqual({ planId: 'plan-field' });
    expect(after.rateSheets).toEqual({ default: 1 });
    expect(after.roleLabels).toEqual({ dispatch: 'Coordinator' });
    expect(after.roleCapabilities).toEqual({ dispatch: ['createDispatch', 'viewHome'] });
  });

  it('failed validation performs no write', async () => {
    const store = new MemoryRoleStore();
    store.companies.set(COMPANY, { name: 'Liquid Gold' });
    const r = await runStaffWriteRoleCapabilities({
      authority: authority(),
      request: req({ roleCapabilities: { dispatch: ['viewAllCompanies'] } }),
      store,
    });
    expect(r.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.companies.get(COMPANY)).toEqual({ name: 'Liquid Gold' });
  });

  it('failed transaction performs no partial write', async () => {
    const store = new MemoryRoleStore();
    store.companies.set(COMPANY, { name: 'Liquid Gold' });
    store.failNext = 'updateCompany';
    await expect(runStaffWriteRoleCapabilities({
      authority: authority(),
      request: req(),
      store,
    })).rejects.toThrow('tx-fail');
    expect(store.companies.get(COMPANY)).toEqual({ name: 'Liquid Gold' });
    expect(store.writes).toEqual([]);
  });

  it('unauthenticated and missing company reject without writing', async () => {
    const store = new MemoryRoleStore();
    store.companies.set(COMPANY, { name: 'X' });
    expect((await runStaffWriteRoleCapabilities({
      authority: null,
      request: req(),
      store,
    })).ok).toBe(false);
    expect((await runStaffWriteRoleCapabilities({
      authority: authority({ companyId: '' }),
      request: req(),
      store,
    })).ok).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('missing company document rejects', async () => {
    const store = new MemoryRoleStore();
    const r = await runStaffWriteRoleCapabilities({
      authority: authority(),
      request: req(),
      store,
    });
    expect(r).toMatchObject({ ok: false, reason: 'company_not_found' });
  });
});

describe('callable wiring', () => {
  it('exports the governed editor and uses trusted manageRolesAndCapabilities', () => {
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'staffWriteRoleCapabilitiesCallable.ts'),
      'utf8',
    );
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_ROLES/);
    expect(callable).toMatch(/enforceAppCheck:\s*false/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/targetCompanyId/);
    expect(callable).not.toMatch(/admin\.database\(\)/);
    expect(STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE).toBe('staffWriteRoleCapabilities');
    expect(TRUSTED_CAPABILITY_MANAGE_ROLES).toBe('manageRolesAndCapabilities');
    const root = readFileSync(join(ROOT, 'functions', 'src', 'index.ts'), 'utf8');
    const security = readFileSync(join(ROOT, 'functions', 'src', 'security', 'index.ts'), 'utf8');
    expect(root).toMatch(/staffWriteRoleCapabilities/);
    expect(security).toMatch(/staffWriteRoleCapabilities/);
    expect(root).not.toMatch(/provisionTrustedStaff/);
    expect(root).not.toMatch(/writeTrustedStaffAuthority/);
  });
});
