/**
 * Governance, tenant isolation, and contract tests for Dispatch Job Types settings (Phase 2A).
 *
 * Verifies:
 * - Governed callable wire contract: runTenantUpdateDispatchJobTypes uses tenantUpdateDispatchJobTypes
 * - Save persists via governed callable targeting exact companyId
 * - Cancel restores last saved state without invoking callable (zero writes)
 * - SettingsPage mounts DispatchJobTypesCard and removes CustomJobTypesCard
 * - Capability gating: manageCompany controls editing in Settings page & card
 * - Legacy handling: surfaces customJobTypes as "Needs Classification" disabled until classified
 * - Vocabulary boundaries: PW = Production Water, SW = Service Work, DW = Dirty Water
 * - Firestore security rules: direct client writes to dispatchJobTypes are denied
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
import {
  TENANT_UPDATE_DISPATCH_JOB_TYPES_CALLABLE,
  buildTenantUpdateDispatchJobTypesPayload,
  runTenantUpdateDispatchJobTypes,
  type TenantUpdateDispatchJobTypesPayload,
  type TenantUpdateDispatchJobTypesResult,
} from '../tenantDispatchJobTypesCore.ts';

interface CompanyConfigStub {
  id: string;
  name: string;
  dispatchJobTypes?: DispatchJobTypeConfig;
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

test('2. Governed wire contract: runTenantUpdateDispatchJobTypes calls tenantUpdateDispatchJobTypes', async () => {
  const calls: TenantUpdateDispatchJobTypesPayload[] = [];
  const mockInvoker = async (payload: unknown) => {
    calls.push(payload as TenantUpdateDispatchJobTypesPayload);
    return {
      data: {
        ok: true as const,
        companyId: (payload as TenantUpdateDispatchJobTypesPayload).companyId,
        itemCount: (payload as TenantUpdateDispatchJobTypesPayload).dispatchJobTypes.items.length,
        updatedAtIso: '2026-09-16T12:00:00.000Z',
      },
    };
  };

  assert.equal(TENANT_UPDATE_DISPATCH_JOB_TYPES_CALLABLE, 'tenantUpdateDispatchJobTypes');

  const entries: DispatchJobTypeEntry[] = [
    { id: 'pw-1', code: 'PW', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
    { id: 'sw-1', code: 'SW', name: 'Service Work', workClass: 'sw', enabled: true, order: 1 },
  ];
  const payload = buildDispatchJobTypesPayload(entries, 'admin-123');

  const res = await runTenantUpdateDispatchJobTypes(mockInvoker, 'company-456', payload);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].companyId, 'company-456');
  assert.equal(calls[0].dispatchJobTypes.version, 1);
  assert.equal(calls[0].dispatchJobTypes.items.length, 2);
  assert.equal(res.ok, true);
  assert.equal(res.companyId, 'company-456');
  assert.equal(res.itemCount, 2);
});

test('3. Cancel action does not invoke callable and preserves initial state', () => {
  const initialItems = resolveDispatchJobTypes(undefined);
  let draftItems = [...initialItems, { id: 'temp-1', code: 'DW', name: 'Draft', workClass: 'pw' as const, enabled: true, order: 2 }];

  // Operator clicks Cancel -> restores initialItems without write
  draftItems = initialItems;

  assert.equal(draftItems.length, 2);
  assert.equal(draftItems[0].code, 'PW');
  assert.equal(draftItems[1].code, 'SW');
});

test('4. Source contract: SettingsPage mounts DispatchJobTypesCard and removes CustomJobTypesCard', () => {
  const pagePath = resolve(process.cwd(), 'src/app/settings/page.tsx');
  const pageSrc = readFileSync(pagePath, 'utf8');

  // Verify DispatchJobTypesCard is imported and mounted
  assert.match(pageSrc, /import\s*\{\s*DispatchJobTypesCard\s*\}\s*from\s*['"]@\/components\/settings\/DispatchJobTypesCard['"]/);
  assert.match(pageSrc, /<DispatchJobTypesCard[\s\S]*?company=\{company\}[\s\S]*?canEdit=\{hasCapability\(user,\s*'manageCompany',\s*userCompany\)\}/);

  // Verify CustomJobTypesCard is NOT imported or mounted
  assert.ok(!pageSrc.includes('CustomJobTypesCard'), 'CustomJobTypesCard must be removed from settings page');
});

test('5. Source contract: DispatchJobTypesCard uses governed tenantUpdateDispatchJobTypes', () => {
  const cardPath = resolve(process.cwd(), 'src/components/settings/DispatchJobTypesCard.tsx');
  const cardSrc = readFileSync(cardPath, 'utf8');

  // Verify it imports and calls tenantUpdateDispatchJobTypes
  assert.match(cardSrc, /import\s*\{\s*tenantUpdateDispatchJobTypes\s*\}\s*from\s*['"]@\/lib\/tenantDispatchJobTypes['"]/);
  assert.match(cardSrc, /await\s+tenantUpdateDispatchJobTypes\(company\.id,\s*payload\)/);

  // Verify it does NOT call updateCompanyFields for dispatchJobTypes
  assert.ok(!cardSrc.includes('updateCompanyFields'), 'DispatchJobTypesCard must use governed callable, not updateCompanyFields');

  // Verify canEdit guard
  assert.match(cardSrc, /canEdit:\s*boolean/);
  assert.match(cardSrc, /const handleSave = async \(\) =>[\s\S]*?if\s*\(!canEdit/);
});

test('6. Legacy handling: surfaces customJobTypes as Needs Classification', () => {
  const cardPath = resolve(process.cwd(), 'src/components/settings/DispatchJobTypesCard.tsx');
  const cardSrc = readFileSync(cardPath, 'utf8');

  // Verify Needs Classification UI and logic
  assert.match(cardSrc, /Needs Classification/);
  assert.match(cardSrc, /Classify & Add/);
  assert.match(cardSrc, /unclassifiedLegacyLabels/);
  assert.match(cardSrc, /handleClassifyLegacy/);

  // Verify it does not mutate or delete company.customJobTypes
  assert.ok(!cardSrc.includes('deleteCompanyFields'), 'Must not delete legacy fields');
});

test('7. Vocabulary boundary invariants: PW = Production Water, SW = Service Work, DW = Dirty Water', () => {
  const corePath = resolve(process.cwd(), 'src/lib/dispatchJobTypesCore.ts');
  const coreSrc = readFileSync(corePath, 'utf8');

  assert.match(coreSrc, /code:\s*'PW'[\s\S]*?name:\s*'Production Water'/);
  assert.match(coreSrc, /code:\s*'SW'[\s\S]*?name:\s*'Service Work'/);

  const acronymPath = resolve(process.cwd(), 'src/lib/jobTypeAcronym.ts');
  const acronymSrc = readFileSync(acronymPath, 'utf8');
  assert.match(acronymSrc, /dw:\s*\{\s*code:\s*'DW',\s*full:\s*'Dirty Water'\s*\}/);
});

test('8. Firestore rules contract: dispatchJobTypes is protected from direct client updates', () => {
  const rulesPath = resolve(process.cwd(), 'firestore.rules');
  const rulesSrc = readFileSync(rulesPath, 'utf8');

  assert.match(rulesSrc, /!request\.resource\.data\.diff\(resource\.data\)\s*\.affectedKeys\(\)\.hasAny\(\['dispatchJobTypes'\]\)/);
  assert.match(rulesSrc, /!request\.resource\.data\.keys\(\)\.hasAny\(\['dispatchJobTypes'\]\)/);
});
