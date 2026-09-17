import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyPublicCompanyProjection,
  publicCompanyPath,
} from '../publicCompanyWriter';
import {
  PUBLIC_COMPANY_SENSITIVE_NEVER,
  PUBLIC_COMPANY_WHITELIST,
} from '../publicCompanyProjection';

function mockStore() {
  const sets: Array<{ path: string; data: Record<string, unknown>; opts: { merge: false } }> = [];
  const deletes: string[] = [];
  return {
    sets,
    deletes,
    store: {
      async set(path: string, data: Record<string, unknown>, opts: { merge: false }) {
        sets.push({ path, data, opts });
      },
      async delete(path: string) {
        deletes.push(path);
      },
    },
  };
}

const SOURCE = {
  name: 'Acme Hauling',
  status: 'active',
  tier: 'field',
  logoUrl: 'https://cdn.test/a.png',
  address: '12 Main',
  phone: '555-0100',
  rateSheets: { x: [] },
  payConfig: { defaultSplit: 0.3 },
  roleCapabilities: { it: ['viewAdmin'] },
  wellbuiltContract: { planId: 'plan-field' },
  assignedOperators: ['SLAWSON'],
};

describe('applyPublicCompanyProjection', () => {
  test('full-replacement set (merge: false) of whitelist fields only', async () => {
    const { store, sets, deletes } = mockStore();
    const result = await applyPublicCompanyProjection(
      store,
      'acme-hauling',
      SOURCE,
      true,
      'NOW',
    );
    expect(result).toBe('projected');
    expect(deletes).toEqual([]);
    expect(sets).toHaveLength(1);
    expect(sets[0].path).toBe('public_companies/acme-hauling');
    expect(sets[0].opts).toEqual({ merge: false });
    expect(sets[0].data).toEqual({
      name: 'Acme Hauling',
      status: 'active',
      tier: 'field',
      logoUrl: 'https://cdn.test/a.png',
      updatedAt: 'NOW',
    });
    for (const key of PUBLIC_COMPANY_SENSITIVE_NEVER) {
      expect(sets[0].data).not.toHaveProperty(key);
    }
    for (const key of Object.keys(sets[0].data)) {
      expect(PUBLIC_COMPANY_WHITELIST).toContain(key);
    }
  });

  test('source field removal cannot remain stale — replacement omits it', async () => {
    const { store, sets } = mockStore();
    await applyPublicCompanyProjection(store, 'acme-hauling', SOURCE, true, 't1');
    const withoutLogo = { name: 'Acme Hauling', status: 'active', tier: 'field' };
    await applyPublicCompanyProjection(store, 'acme-hauling', withoutLogo, true, 't2');
    expect(sets[1].opts).toEqual({ merge: false });
    expect(sets[1].data).toEqual({
      name: 'Acme Hauling',
      status: 'active',
      tier: 'field',
      updatedAt: 't2',
    });
    expect(sets[1].data).not.toHaveProperty('logoUrl');
  });

  test('source delete removes the public projection', async () => {
    const { store, sets, deletes } = mockStore();
    const result = await applyPublicCompanyProjection(
      store,
      'gone-co',
      SOURCE,
      false,
      'NOW',
    );
    expect(result).toBe('deleted');
    expect(sets).toEqual([]);
    expect(deletes).toEqual(['public_companies/gone-co']);
  });

  test('publicCompanyPath is the public collection + id', () => {
    expect(publicCompanyPath('liquid-gold')).toBe('public_companies/liquid-gold');
  });
});

describe('writer wiring — trigger is companies root, full replace, no client path', () => {
  const writerSrc = readFileSync(
    join(__dirname, '../publicCompanyWriter.ts'),
    'utf8',
  );
  const indexSrc = readFileSync(
    join(__dirname, '../../index.ts'),
    'utf8',
  );

  test('trigger watches companies/{companyId} and uses v2 onDocumentWritten', () => {
    expect(writerSrc).toContain("from 'firebase-functions/v2/firestore'");
    expect(writerSrc).toContain('onDocumentWritten');
    expect(writerSrc).toContain("document: 'companies/{companyId}'");
  });

  test('writes via set(..., { merge: false }) and delete() — never update/merge', () => {
    expect(writerSrc).toContain('store.set(path, projected, { merge: false })');
    expect(writerSrc).toContain('store.delete(path)');
    expect(writerSrc).not.toMatch(/\.update\(/);
    expect(writerSrc).not.toMatch(/merge:\s*true/);
  });

  test('index exports the trigger and does not export a production backfill callable', () => {
    expect(indexSrc).toContain('projectPublicCompanyOnWrite');
    expect(indexSrc).not.toContain('backfillPublicCompanies');
  });
});
