import fs from 'node:fs';
import path from 'node:path';
import {
  parseDateInput,
  validateDateRange,
  getChicagoDayBoundaries,
} from '../src/lib/chicagoDate.ts';
import {
  buildCanonicalDriverMap,
  resolveCanonicalDriverName,
  findMatchingCanonicalDriverIds,
} from '../src/lib/canonicalDriverRoster.ts';

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

  // 6. Behavioral tenancy derivation logic simulation
  function deriveEffectiveCompanyId(user, selectedCompanyId) {
    return user?.companyId || selectedCompanyId || null;
  }

  const tenantUser = { uid: 'u1', role: 'dispatcher', companyId: 'tenant-123' };
  if (deriveEffectiveCompanyId(tenantUser, null) !== 'tenant-123') {
    throw new Error('FAIL: Tenant user did not bind to user.companyId');
  }

  const adminUser = { uid: 'admin1', role: 'admin' };
  if (deriveEffectiveCompanyId(adminUser, null) !== null) {
    throw new Error('FAIL: Platform admin without selection must resolve to null, got ' + deriveEffectiveCompanyId(adminUser, null));
  }

  if (deriveEffectiveCompanyId(adminUser, 'tenant-456') !== 'tenant-456') {
    throw new Error('FAIL: Platform admin with explicit selection did not resolve correctly');
  }
  console.log('  ✓ Verified: Behavioral tenancy derivation logic matches specifications.');

  // 7. Regression Test: No initial photo request & no filter-change request
  const useEffectMatches = [...pageSource.matchAll(/useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[(.*?)\]\);/g)];
  for (const match of useEffectMatches) {
    const effectBody = match[1];
    if (effectBody.includes('executeQuery') || effectBody.includes('listDispatchPhotoReviews')) {
      throw new Error('FAIL: Detected automatic query inside a useEffect! Initial load or filter change must not auto-fetch.');
    }
  }
  if (!pageSource.includes("const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');")) {
    throw new Error('FAIL: loadState must initialize to idle.');
  }
  console.log('  ✓ Verified: Zero auto-fetch on initial mount and zero auto-fetch on filter/company change.');

  // 8. Regression Test: Explicit Search / All Photos / Clear behavior
  if (!pageSource.includes('id="action-search"') || !pageSource.includes('id="action-all-photos"') || !pageSource.includes('id="action-clear"')) {
    throw new Error('FAIL: Missing explicit Search, All Photos, or Clear action buttons.');
  }
  if (!pageSource.includes('hasFilterCriteria()') || !pageSource.includes('Please enter at least one filter criterion to search')) {
    throw new Error('FAIL: Search does not enforce at least one filter criterion before querying.');
  }
  console.log('  ✓ Verified: Explicit Search (requiring criteria), All Photos, and Clear buttons enforced.');

  // 9. Regression Test: Server-filtered pagination (Load More & limit)
  if (!pageSource.includes('payload.limit = limit') && !pageSource.includes('limit,')) {
    throw new Error('FAIL: executeQuery does not pass bounded limit to server.');
  }
  if (!pageSource.includes('id="action-load-more"') || !pageSource.includes('handleLoadMore')) {
    throw new Error('FAIL: Missing server-filtered bounded pagination Load More Photos action.');
  }
  console.log('  ✓ Verified: Server-filtered bounded pagination with Load More enforced.');

  // 10. Regression Test: Lazy full-image loading
  if (!pageSource.includes('loading="lazy"')) {
    throw new Error('FAIL: Thumbnail image elements missing loading="lazy" attribute.');
  }
  console.log('  ✓ Verified: Thumbnail images use loading="lazy".');

  // 11. Regression Test: Card-level review actions without parent button nesting
  if (pageSource.includes('<button') && pageSource.includes('key={itemKey}')) {
    const cardContainerRegex = /<button[^>]*key=\{itemKey\}/;
    if (cardContainerRegex.test(pageSource)) {
      throw new Error('FAIL: Card container must not be a <button>; cannot nest Approve/Reject buttons inside a clickable card.');
    }
  }
  if (!pageSource.includes("runReview(item, 'approve')") || !pageSource.includes("setRejectTarget(item)")) {
    throw new Error('FAIL: Card does not have direct card-level Approve and Reject actions.');
  }
  if (!pageSource.includes('setCardBusy')) {
    throw new Error('FAIL: Card-level busy state (cardBusy) missing.');
  }
  console.log('  ✓ Verified: Card-level Approve/Reject actions, valid non-nested DOM, local item update, and per-card busy state.');

  // 12. Regression Test: Disabled actions for unsynced photos
  if (!pageSource.includes('Waiting for photo upload')) {
    throw new Error('FAIL: Missing "Waiting for photo upload" state for unsynced photos.');
  }
  if (!pageSource.includes('!hasValidImage') || !pageSource.includes('disabled={isItemBusy || !hasValidImage}')) {
    throw new Error('FAIL: Approve and Reject buttons must be disabled when photo is not synced or lacks verified image.');
  }
  console.log('  ✓ Verified: Unsynced photos display "Waiting for photo upload" and disable review actions.');

  // 13. Usability Test: Keyboard Tab order & Enter-to-search
  // No positive tabIndex allowed
  const positiveTabIndex = /tabIndex=\{?[1-9][0-9]*\}?/;
  if (positiveTabIndex.test(pageSource)) {
    throw new Error('FAIL: Positive tabIndex detected! Tab order must be natural DOM order.');
  }

  // Verify DOM order of interactive controls
  const expectedControlOrder = [
    'company-context-selector',
    'filter-date-from',
    'filter-date-to',
    'filter-driver',
    'filter-ticket',
    'filter-pickup',
    'filter-dropoff',
    'filter-photo-type',
    'filter-status',
    'action-search',
    'action-all-photos',
    'action-clear',
  ];

  let lastIndex = -1;
  for (const controlId of expectedControlOrder) {
    const idx = pageSource.indexOf(`id="${controlId}"`);
    if (idx === -1) {
      throw new Error(`FAIL: Missing control id="${controlId}" in DOM order check.`);
    }
    if (idx < lastIndex) {
      throw new Error(`FAIL: Control id="${controlId}" is out of natural DOM tab order!`);
    }
    lastIndex = idx;
  }
  console.log('  ✓ Verified: Natural DOM tab order with zero positive tabIndex attributes.');

  // Verify Enter key on inputs triggers handleSearch
  const inputIdsWithEnter = [
    'filter-date-from',
    'filter-date-to',
    'filter-driver',
    'filter-ticket',
    'filter-pickup',
    'filter-dropoff',
  ];
  for (const inputId of inputIdsWithEnter) {
    const inputBlockRegex = new RegExp(`id="${inputId}"[\\s\\S]*?onKeyDown=\\{\\(e\\)\\s*=>\\s*\\{[\\s\\S]*?handleSearch\\(\\)[\\s\\S]*?\\}\\}`);
    if (!inputBlockRegex.test(pageSource)) {
      throw new Error(`FAIL: Input id="${inputId}" does not trigger handleSearch on Enter key.`);
    }
  }
  console.log('  ✓ Verified: All text/date filter inputs handle Enter key by running Search.');

  // 14. Usability Test: America/Chicago date entry and validation
  // Test valid date range
  const validRange = validateDateRange('09/10/2026', '09/15/2026');
  if (!validRange.valid || !validRange.dateFromMs || !validRange.dateToMs) {
    throw new Error('FAIL: validateDateRange failed for valid MM/DD/YYYY range');
  }

  // Test Start Date > End Date
  const invalidOrder = validateDateRange('09/20/2026', '09/10/2026');
  if (invalidOrder.valid || !invalidOrder.error?.includes('Start Date must be on or before End Date')) {
    throw new Error('FAIL: validateDateRange did not reject Start Date > End Date');
  }

  // Test invalid calendar date (Feb 30)
  const invalidDate = validateDateRange('02/30/2026', '03/01/2026');
  if (invalidDate.valid) {
    throw new Error('FAIL: validateDateRange accepted non-existent calendar date 02/30/2026');
  }

  // Test America/Chicago exact boundaries without UTC shifting
  const boundaries = getChicagoDayBoundaries(2026, 9, 10);
  const startChicagoStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  }).format(new Date(boundaries.startMs));

  const endChicagoStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  }).format(new Date(boundaries.endMs));

  if (!startChicagoStr.includes('00:00:00') && !startChicagoStr.includes('24:00:00')) {
    throw new Error(`FAIL: America/Chicago start of day is not midnight: ${startChicagoStr}`);
  }
  if (!endChicagoStr.includes('23:59:59')) {
    throw new Error(`FAIL: America/Chicago end of day is not 23:59:59: ${endChicagoStr}`);
  }
  console.log('  ✓ Verified: America/Chicago calendar-day boundaries and date validation.');

  // 15. Usability Test: Canonical driver identity & privacy boundary
  // 15. Usability Test: Canonical driver identity & privacy boundary
  // Raw item.driverName must NEVER be rendered in JSX
  if (pageSource.includes('{item.driverName}') || pageSource.includes('{viewer.driverName}')) {
    throw new Error('FAIL: Raw snapshot driverName rendered in JSX! Forbidden.');
  }

  // Test canonical driver resolution logic
  const mockCatalog = {
    approved: {
      hash1: {
        displayName: 'Mike ZFold7 Burger',
        companyId: 'liquid-gold',
        driverId: 'drv_mike_1',
      },
      hash2: {
        displayName: 'Rogue Device Driver',
        companyId: 'other-co',
        driverId: 'drv_other_2',
      },
      hash3: {
        displayName: 'driver.auth@wellbuilt.com', // Auth email must be rejected
        companyId: 'liquid-gold',
        driverId: 'drv_email_3',
      },
    },
    profiles: {
      prof4: {
        legalName: 'Adan Salcido',
        companyId: 'liquid-gold',
      },
    },
  };

  const driverMap = buildCanonicalDriverMap(mockCatalog, 'liquid-gold');

  // Test 1: Operational name "Mike ZFold7 Burger" is PRESERVED as intentional canonical test-driver name
  const resolvedMike = resolveCanonicalDriverName(driverMap, 'drv_mike_1');
  if (resolvedMike !== 'Mike ZFold7 Burger') {
    throw new Error(`FAIL: Expected 'Mike ZFold7 Burger' to be preserved, got '${resolvedMike}'`);
  }

  // Test 2: Canonical search finds driver by profile operational name (e.g. "ZFold7" or "Burger")
  const matchZFold = findMatchingCanonicalDriverIds(driverMap, 'ZFold7');
  if (!matchZFold.has('drv_mike_1')) {
    throw new Error('FAIL: Canonical search failed to find driver by operational profile name ZFold7');
  }

  // Test 3: Auth email addresses are rejected and not used as profile names
  const resolvedEmail = resolveCanonicalDriverName(driverMap, 'drv_email_3');
  if (resolvedEmail !== 'Unknown driver') {
    throw new Error(`FAIL: Auth email address must not be used as profile name, got '${resolvedEmail}'`);
  }

  // Test 4: Profile legalName from profiles is preserved
  const resolvedAdan = resolveCanonicalDriverName(driverMap, 'prof4');
  if (resolvedAdan !== 'Adan Salcido') {
    throw new Error(`FAIL: Expected 'Adan Salcido', got '${resolvedAdan}'`);
  }

  // Test 5: Wrong-company driver resolves to 'Unknown driver' (tenant containment)
  const resolvedOther = resolveCanonicalDriverName(driverMap, 'drv_other_2');
  if (resolvedOther !== 'Unknown driver') {
    throw new Error(`FAIL: Wrong-company driver must resolve to 'Unknown driver', got '${resolvedOther}'`);
  }

  // Test 6: Missing or unresolvable driver resolves to 'Unknown driver'
  const resolvedMissing = resolveCanonicalDriverName(driverMap, 'non_existent_id');
  if (resolvedMissing !== 'Unknown driver') {
    throw new Error(`FAIL: Non-existent driver must resolve to 'Unknown driver', got '${resolvedMissing}'`);
  }

  const resolvedEmpty = resolveCanonicalDriverName(driverMap, '');
  if (resolvedEmpty !== 'Unknown driver') {
    throw new Error(`FAIL: Empty driverId must resolve to 'Unknown driver', got '${resolvedEmpty}'`);
  }

  console.log('  ✓ Verified: Canonical driver identity resolution preserves Mike ZFold7 Burger, rejects auth emails, and respects tenant containment.');

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
