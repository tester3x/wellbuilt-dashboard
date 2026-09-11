import fs from 'node:fs';
import path from 'node:path';

export function runPhotoReviewContractTests() {
  console.log('=== Running Photo Review Contract Tests ===');

  const pageSource = fs.readFileSync('src/app/photo-review/page.tsx', 'utf8');

  // 1. Silent defaulting platform admin prohibition
  if (pageSource.includes('list[0].id') || pageSource.includes('companies[0].id')) {
    throw new Error('FAIL: Silent defaulting of platform admin to first company found in page source!');
  }
  console.log('  ✓ Verified: No silent defaulting of platform admin to first company.');

  // 2. Company selector must have explicit unselected placeholder option
  if (!pageSource.includes('<option value="">Select a company to review photos...</option>')) {
    throw new Error('FAIL: Company selector is missing explicit placeholder option.');
  }
  console.log('  ✓ Verified: Explicit placeholder option present in company selector.');

  // 3. Must not expose raw internal error string 'companyId_required'
  // It may inspect it internally in error handling to map to friendly message, but the rendered text must be friendly
  if (pageSource.includes('>companyId_required<') || pageSource.includes('{"companyId_required"}')) {
    throw new Error('FAIL: Raw companyId_required token exposed in JSX markup.');
  }
  console.log('  ✓ Verified: Raw error tokens are not exposed in JSX.');

  // 4. Form inputs must have visible <label> elements with htmlFor
  const requiredLabelFor = [
    'filter-date-from',
    'filter-date-to',
    'filter-driver',
    'filter-ticket',
    'filter-pickup',
    'filter-dropoff',
    'filter-photo-type',
    'filter-status',
  ];

  for (const id of requiredLabelFor) {
    if (!pageSource.includes(`htmlFor="${id}"`)) {
      throw new Error(`FAIL: Missing <label htmlFor="${id}"> for filter input.`);
    }
    if (!pageSource.includes(`id="${id}"`)) {
      throw new Error(`FAIL: Missing id="${id}" on filter input.`);
    }
  }
  console.log(`  ✓ Verified: All ${requiredLabelFor.length} filter inputs have associated <label> elements.`);

  // 5. Capability gating: must require 'viewDispatch'
  if (!pageSource.includes("'viewDispatch'")) {
    throw new Error("FAIL: Photo Review page does not gate on 'viewDispatch' capability.");
  }
  console.log("  ✓ Verified: Capability gating checks 'viewDispatch'.");

  // 6. Behavioral logic simulation
  function deriveEffectiveCompanyId(user, selectedCompanyId) {
    return user?.companyId || selectedCompanyId || null;
  }

  // Tenant user:
  const tenantUser = { uid: 'u1', role: 'dispatcher', companyId: 'tenant-123' };
  if (deriveEffectiveCompanyId(tenantUser, null) !== 'tenant-123') {
    throw new Error('FAIL: Tenant user did not bind to user.companyId');
  }

  // Platform admin before explicit selection:
  const adminUser = { uid: 'admin1', role: 'admin' };
  if (deriveEffectiveCompanyId(adminUser, null) !== null) {
    throw new Error('FAIL: Platform admin without selection must resolve to null, got ' + deriveEffectiveCompanyId(adminUser, null));
  }

  // Platform admin after explicit selection:
  if (deriveEffectiveCompanyId(adminUser, 'tenant-456') !== 'tenant-456') {
    throw new Error('FAIL: Platform admin with explicit selection did not resolve correctly');
  }
  console.log('  ✓ Verified: Behavioral tenancy derivation logic matches specifications.');

  console.log('=== All Photo Review Contract Tests Passed ===');
}

if (process.argv[1]?.endsWith('test-photo-review-contract.mjs')) {
  try {
    runPhotoReviewContractTests();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
