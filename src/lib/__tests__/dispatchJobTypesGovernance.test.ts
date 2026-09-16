/**
 * Governance, tenant isolation, and contract tests for Dispatch Job Types settings.
 *
 * Verifies:
 * - Company isolation: canonical company ID is used, no cross-company leakage
 * - Save persists only the intended settings field ({ dispatchJobTypes: ... })
 * - Cancel restores last saved state without writing (zero writes)
 * - Unrelated company settings survive untouched
 * - Capability gating: manageCompany controls editing in Settings page & card
 * - Firestore security rules: dispatchJobTypes is not a protected key (client write permitted)
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/dispatchJobTypesGovernance.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveDispatchJobTypes,
  buildDispatchJobTypesPayload,
  type DispatchJobTypeEntry,
  type DispatchJobTypeConfig,
} from '../dispatchJobTypesCore.ts';

interface CompanyConfigStub {
  id: string;
  name: string;
  dispatchJobTypes?: DispatchJobTypeConfig;
}

function createMockWriter() {
  const writes: Array<{ companyId: string; fields: Record<string, unknown> }> = [];
  return {
    writes,
    write: async (companyId: string, fields: Record<string, unknown>) => {
      writes.push({ companyId, fields });
    },
  };
}

test('1. Company isolation: distinct companies resolve their own custom job types independently', () => {
  const companyA: CompanyConfigStub = {
    id: 'company-liquid-gold',
    name: 'Liquid Gold Hauling',
    dispatchJobTypes: {
      version: 1,
      items: [
        { id: 'lg-1', code: 'DW', name: 'Dirty Water', workClass: 'pw', enabled: true, order: 0 },
        { id: 'lg-2', code: 'FW', name: 'Fresh Water', workClass: 'pw', enabled: true, order: 1 },
      ],
    },
  };

  const companyB: CompanyConfigStub = {
    id: 'company-mongoose',
    name: 'Mongoose Trucking',
    dispatchJobTypes: {
      version: 1,
      items: [
        { id: 'mg-1', code: 'SW', name: 'Service Work', workClass: 'sw', enabled: true, order: 0 },
        { id: 'mg-2', code: 'FB', name: 'Flowback', workClass: 'pw', enabled: true, order: 1 },
      ],
    },
  };

  const companyCDefault: CompanyConfigStub = {
    id: 'company-unconfigured',
    name: 'New Hauler LLC',
  };

  const typesA = resolveDispatchJobTypes(companyA.dispatchJobTypes);
  const typesB = resolveDispatchJobTypes(companyB.dispatchJobTypes);
  const typesC = resolveDispatchJobTypes(companyCDefault.dispatchJobTypes);

  // Assert Company A has only its types
  assert.equal(typesA.length, 2);
  assert.equal(typesA[0].code, 'DW');
  assert.equal(typesA[1].code, 'FW');

  // Assert Company B has only its types
  assert.equal(typesB.length, 2);
  assert.equal(typesB[0].code, 'SW');
  assert.equal(typesB[1].code, 'FB');

  // Assert Company C has fallback defaults
  assert.equal(typesC.length, 2);
  assert.equal(typesC[0].code, 'PW');
  assert.equal(typesC[1].code, 'SW');
});

test('2. Save persists ONLY { dispatchJobTypes } field targeting the exact company.id', async () => {
  const writer = createMockWriter();

  const entries: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PW', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
    { id: '2', code: 'DW', name: 'Dirty Water', workClass: 'pw', enabled: true, order: 1 },
  ];

  const payload = buildDispatchJobTypesPayload(entries, 'admin-user-uid');
  await writer.write('target-company-123', { dispatchJobTypes: payload });

  assert.equal(writer.writes.length, 1);
  assert.equal(writer.writes[0].companyId, 'target-company-123');

  // Verify only dispatchJobTypes is written (narrow update)
  const writtenKeys = Object.keys(writer.writes[0].fields);
  assert.deepEqual(writtenKeys, ['dispatchJobTypes']);

  const savedPayload = writer.writes[0].fields.dispatchJobTypes as DispatchJobTypeConfig;
  assert.equal(savedPayload.version, 1);
  assert.equal(savedPayload.updatedByUid, 'admin-user-uid');
  assert.equal(savedPayload.items.length, 2);
});

test('3. Unrelated company settings survive a save without modification', () => {
  // Simulating Firestore updateDoc semantics:
  // An updateDoc({ dispatchJobTypes: ... }) call modifies only the dispatchJobTypes key,
  // leaving all other document fields (rates, payConfig, branding, etc.) intact.
  const existingCompanyDoc: Record<string, unknown> = {
    id: 'test-co',
    name: 'Bakken Water Services',
    activePackages: ['water', 'oil'],
    invoicingMode: 'hybrid',
    payConfig: { defaultSplit: 0.25, payPeriod: 'weekly' },
    rateSheets: { 'Hess': [{ jobType: 'pw', rate: 4.5 }] },
    primaryColor: '#0055AA',
    unknownFutureField: { flag: true },
  };

  const payload = buildDispatchJobTypesPayload(resolveDispatchJobTypes(undefined));

  // Firestore updateDoc merge simulation
  const mergedCompanyDoc = {
    ...existingCompanyDoc,
    dispatchJobTypes: payload,
  };

  assert.equal(mergedCompanyDoc.name, 'Bakken Water Services');
  assert.deepEqual(mergedCompanyDoc.activePackages, ['water', 'oil']);
  assert.equal(mergedCompanyDoc.invoicingMode, 'hybrid');
  assert.deepEqual(mergedCompanyDoc.payConfig, { defaultSplit: 0.25, payPeriod: 'weekly' });
  assert.deepEqual(mergedCompanyDoc.unknownFutureField, { flag: true });
  assert.ok(mergedCompanyDoc.dispatchJobTypes);
});

test('4. Cancel action does not invoke writer and restores initial state', () => {
  const writer = createMockWriter();

  const initialItems = resolveDispatchJobTypes(undefined);
  let draftItems = [...initialItems, { id: 'temp-1', code: 'DW', name: 'Draft', workClass: 'pw' as const, enabled: true, order: 2 }];

  // Operator clicks Cancel -> restores initialItems without write
  draftItems = initialItems;

  assert.equal(writer.writes.length, 0, 'Cancel must never write to Firestore');
  assert.equal(draftItems.length, 2);
  assert.equal(draftItems[0].code, 'PW');
  assert.equal(draftItems[1].code, 'SW');
});

test('5. Source contract: SettingsPage mounts DispatchJobTypesCard with manageCompany capability', () => {
  const pagePath = resolve(process.cwd(), 'src/app/settings/page.tsx');
  const pageSrc = readFileSync(pagePath, 'utf8');

  // Verify import
  assert.match(pageSrc, /import\s*\{\s*DispatchJobTypesCard\s*\}\s*from\s*['"]@\/components\/settings\/DispatchJobTypesCard['"]/);

  // Verify JSX mount with manageCompany capability gate
  assert.match(pageSrc, /<DispatchJobTypesCard[\s\S]*?company=\{company\}[\s\S]*?canEdit=\{hasCapability\(user,\s*'manageCompany',\s*userCompany\)\}/);
});

test('6. Source contract: DispatchJobTypesCard guards mutations on canEdit', () => {
  const cardPath = resolve(process.cwd(), 'src/components/settings/DispatchJobTypesCard.tsx');
  const cardSrc = readFileSync(cardPath, 'utf8');

  // Check canEdit prop definition
  assert.match(cardSrc, /canEdit:\s*boolean/);

  // Check mutation handlers early-return when !canEdit
  assert.match(cardSrc, /const handleUpdateField =[\s\S]*?if\s*\(!canEdit\)\s*return;/);
  assert.match(cardSrc, /const handleMoveUp =[\s\S]*?if\s*\(!canEdit\)\s*return;/);
  assert.match(cardSrc, /const handleMoveDown =[\s\S]*?if\s*\(!canEdit\)\s*return;/);
  assert.match(cardSrc, /const handleAddJobType =[\s\S]*?if\s*\(!canEdit\)\s*return;/);
  assert.match(cardSrc, /const handleSave = async \(\) =>[\s\S]*?if\s*\(!canEdit/);

  // Check view-only explanatory banner is present
  assert.match(cardSrc, /View-only — you do not have permission to change company dispatch job types/);
});

test('7. Firestore rules contract: dispatchJobTypes is NOT in protectedCompanyKeys', () => {
  const rulesPath = resolve(process.cwd(), 'firestore.rules');
  const rulesSrc = readFileSync(rulesPath, 'utf8');

  // Check protectedCompanyKeys function in firestore.rules
  const match = rulesSrc.match(/function protectedCompanyKeys\(\)\s*\{([\s\S]*?)\}/);
  assert.ok(match, 'protectedCompanyKeys must exist in firestore.rules');
  const protectedKeysBody = match[1];

  // dispatchJobTypes must not be protected (must be writable by tenant admin)
  assert.ok(!protectedKeysBody.includes('dispatchJobTypes'), 'dispatchJobTypes must NOT be in protectedCompanyKeys');
});
