import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluateStaffWriteWellConfig,
  findDuplicateApiWell,
  findWellNameKey,
  WELL_CONFIG_CREATE_ALLOWLIST,
} from '../staffWriteWellConfig';

const root = join(__dirname, '../../../../../');
const src = (rel: string) => readFileSync(join(root, rel), 'utf8');

const kahuna2 = {
  route: 'Kahuna 381',
  bottomLevel: 1.3,
  tanks: 6,
  allowedBottom: 1.3,
  numTanks: 6,
  pullBbls: 140,
  tankCapacity: 500,
  tankHeight: 20,
  bblPerFoot: 150,
  ndicName: 'Kahuna 2-6-7H',
  ndicApiNo: '33-053-10170-00-00',
  waterWeight: 9.7,
  h2sStatus: 'none',
};

const lg = { callerCompanyId: 'liquid-gold', isPlatformAdmin: false };

describe('evaluateStaffWriteWellConfig', () => {
  it('creates a linked NDIC well for liquid-gold', () => {
    const d = evaluateStaffWriteWellConfig({
      op: 'create',
      wellName: 'Kahuna 2',
      config: kahuna2,
      existingByName: null,
      existingNameKey: null,
      duplicateApiWell: null,
      ...lg,
    });
    expect(d).toEqual({
      ok: true,
      action: 'create',
      wellName: 'Kahuna 2',
      payload: kahuna2,
    });
    expect((d as { payload: { bottomLevel: number } }).payload.bottomLevel).toBe(1.3);
    expect((d as { payload: { ndicApiNo: string } }).payload.ndicApiNo).toBe('33-053-10170-00-00');
  });

  it('refuses other-company callers', () => {
    const d = evaluateStaffWriteWellConfig({
      op: 'create',
      wellName: 'Kahuna 2',
      config: kahuna2,
      existingByName: null,
      existingNameKey: null,
      duplicateApiWell: null,
      callerCompanyId: 'home-hauling',
      isPlatformAdmin: false,
    });
    expect(d).toMatchObject({ ok: false, reason: 'pool_forbidden' });
  });

  it('treats same name + same API as idempotent retry', () => {
    const d = evaluateStaffWriteWellConfig({
      op: 'create',
      wellName: 'Kahuna 2',
      config: kahuna2,
      existingByName: kahuna2,
      existingNameKey: 'Kahuna 2',
      duplicateApiWell: null,
      ...lg,
    });
    expect(d).toMatchObject({ ok: true, action: 'already_exact', wellName: 'Kahuna 2' });
  });

  it('rejects a duplicate API on a different well', () => {
    const d = evaluateStaffWriteWellConfig({
      op: 'create',
      wellName: 'Kahuna 2',
      config: kahuna2,
      existingByName: null,
      existingNameKey: null,
      duplicateApiWell: 'Other Well',
      ...lg,
    });
    expect(d).toMatchObject({ ok: false, reason: 'duplicate_api' });
  });

  it('does not substitute Kahuna 1 API', () => {
    const d = evaluateStaffWriteWellConfig({
      op: 'create',
      wellName: 'Kahuna 2',
      config: { ...kahuna2, ndicApiNo: '33-053-03504-00-00' },
      existingByName: null,
      existingNameKey: null,
      duplicateApiWell: 'Kahuna 1',
      ...lg,
    });
    expect(d).toMatchObject({ ok: false, reason: 'duplicate_api' });
  });
});

describe('catalog helpers', () => {
  it('matches well names case-insensitively and APIs exactly', () => {
    const all = {
      'Kahuna 1': { ndicApiNo: '33-053-03504-00-00' },
      'Kahuna 2': { ndicApiNo: '33-053-10170-00-00' },
    };
    expect(findWellNameKey(all, 'kahuna 2')).toBe('Kahuna 2');
    expect(findDuplicateApiWell(all, '33-053-10170-00-00', 'Kahuna 2')).toBeNull();
    expect(findDuplicateApiWell(all, '33-053-10170-00-00', 'New')).toBe('Kahuna 2');
  });
});

describe('Add Well wiring pins', () => {
  it('callable is create-only, allowlisted, and Admin-SDK writes', () => {
    const callable = src('functions/src/security/staffWriteWellConfigCallable.ts');
    expect(callable).toContain('requireManageDrivers');
    expect(callable).toContain('evaluateStaffWriteWellConfig');
    expect(callable).toContain('well_config/${decided.wellName}');
    expect(callable).toContain(".set(decided.payload)");
    expect(WELL_CONFIG_CREATE_ALLOWLIST).toContain('ndicApiNo');
    expect(WELL_CONFIG_CREATE_ALLOWLIST).not.toContain('avgFlowRate');
  });

  it('Dashboard Add Well uses the production adapter, not a client RTDB set', () => {
    const page = src('src/app/admin/page.tsx');
    const addStart = page.indexOf('const handleAddWell');
    const addEnd = page.indexOf('const handleUpdateWell');
    expect(addStart).toBeGreaterThan(-1);
    expect(addEnd).toBeGreaterThan(addStart);
    const add = page.slice(addStart, addEnd);
    expect(add).toContain('staffCreateWellConfig');
    expect(add).not.toMatch(/set\(ref\(db,\s*`well_config/);
    expect(add).toContain('classifyAddWellError');
    expect(add).toContain('isAddingWell');
  });
});
