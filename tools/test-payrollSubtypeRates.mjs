/**
 * test-payrollSubtypeRates.mjs
 *
 * Verifies Dashboard Payroll subtype rate logic and source contracts:
 * 1. commodityType (primary jobType) and subjob operate as separate variables.
 * 2. Primary job type governs rate resolution: rate resolution starts from a valid primary job type/alias.
 * 3. Missing or unknown primary job type with Standby returns null (no rate selected solely by subjob).
 * 4. Full hourly rate applies when subjob is absent, empty, or unconfigured.
 * 5. Configured subtype rate exception applies when explicitly associated with that primary entry (e.g. Standby at $80/hr).
 * 6. Primary entry's method is strictly preserved (a per-BBL primary is never converted to hourly by a subtype).
 * 7. Two primary families using different Standby exceptions for the same operator are resolved independently.
 * 8. Standalone subtype entries require an explicit primaryJobType association; generic entries are not applied across families.
 * 9. Subtype matching is case-insensitive.
 * 10. applyRatesToTimesheet re-rate path applies subtype rate exceptions to rows containing subjob.
 * 11. Source contracts verified in companySettings.ts, payroll.ts, billing.ts, and RateSheetsCard.tsx.
 *
 * Run: node tools/test-payrollSubtypeRates.mjs
 *      or npx tsx tools/test-payrollSubtypeRates.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

const isTsx = Boolean(
  process.env.TSX_ACTIVE ||
  process.execArgv.some(a => a.includes('tsx'))
);

// If invoked directly with pure Node (without tsx), delegate to npx tsx so TS imports resolve.
if (!isTsx) {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'npx.cmd' : 'npx';
  const res = spawnSync(cmd, ['tsx', __filename], {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, TSX_ACTIVE: '1' },
    cwd: ROOT,
  });
  process.exit(res.status ?? 0);
}

// ─── TS imports (active under tsx) ──────────────────────────────────────────
const { lookupRate, applyRatesToTimesheet } = await import('../src/lib/payroll.ts');

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('--- Static & Source Contract Verification ---');

const companySettingsSrc = readFileSync(join(ROOT, 'src/lib/companySettings.ts'), 'utf8');
const payrollSrc = readFileSync(join(ROOT, 'src/lib/payroll.ts'), 'utf8');
const billingSrc = readFileSync(join(ROOT, 'src/lib/billing.ts'), 'utf8');
const rateSheetsCardSrc = readFileSync(join(ROOT, 'src/components/settings/RateSheetsCard.tsx'), 'utf8');

check(
  'companySettings.ts: RateEntry defines optional subtypeRates and primaryJobType',
  /subtypeRates\?:\s*Record<string,\s*number>;/.test(companySettingsSrc) &&
  /primaryJobType\?:\s*string;/.test(companySettingsSrc)
);

check(
  'payroll.ts: RateEntry defines optional subtypeRates and primaryJobType',
  /subtypeRates\?:\s*Record<string,\s*number>;/.test(payrollSrc) &&
  /primaryJobType\?:\s*string;/.test(payrollSrc)
);

check(
  'payroll.ts: DriverTimesheetRow defines optional subjob string',
  /subjob\?:\s*string;/.test(payrollSrc)
);

check(
  'payroll.ts: lookupRate signature accepts subjob parameter',
  /export function lookupRate\s*\(\s*rateSheets:\s*CompanyRateSheets,\s*operator:\s*string,\s*jobType:\s*string,\s*subjob\?:\s*string\s*\|\s*null,?\s*\)/.test(payrollSrc)
);

check(
  'payroll.ts: lookupRate requires non-empty primary jobType',
  payrollSrc.includes('if (!jobType || !jobType.trim()) return null;')
);

check(
  'payroll.ts: lookupRate checks baseEntry.subtypeRates before returning',
  payrollSrc.includes('baseEntry.subtypeRates') &&
  payrollSrc.includes('cleanSubLower')
);

check(
  'payroll.ts: lookupRate checks standalone entry explicit primaryJobType association',
  payrollSrc.includes('r.primaryJobType') &&
  payrollSrc.includes('baseJobNormalized')
);

check(
  'payroll.ts: fetchPayrollInvoices extracts subjob from d.subjob || d.serviceType',
  /const subjob\s*=\s*\(d\.subjob\s*as\s*string\)\s*\|\|\s*\(d\.serviceType\s*as\s*string\)\s*\|\|\s*'';/.test(payrollSrc)
);

check(
  'payroll.ts: fetchPayrollInvoices passes subjob to lookupRate',
  /const rateEntry\s*=\s*lookupRate\(rateSheets,\s*operator,\s*jobType,\s*subjob\);/.test(payrollSrc)
);

check(
  'payroll.ts: applyRatesToTimesheet passes row.subjob to lookupRate',
  /const rateEntry\s*=\s*lookupRate\(rateSheets,\s*row\.operator,\s*row\.jobType,\s*row\.subjob\);/.test(payrollSrc)
);

check(
  'billing.ts: extracts subjob and passes to lookupRate',
  /const subjob\s*=\s*\(d\.subjob\s*as\s*string\)\s*\|\|\s*\(d\.serviceType\s*as\s*string\)\s*\|\|\s*'';/.test(billingSrc) &&
  /const rateEntry\s*=\s*lookupRate\(rateSheets,\s*operator,\s*jobType,\s*subjob\);/.test(billingSrc)
);

check(
  'RateSheetsCard.tsx: defines formatSubtypeRates helper',
  /formatSubtypeRates\s*=\s*\(r:\s*RateEntry\)/.test(rateSheetsCardSrc)
);

check(
  'RateSheetsCard.tsx: provides subtype rates editing UI for hourly entries',
  rateSheetsCardSrc.includes('Subjob Exceptions (e.g. Standby)') &&
  rateSheetsCardSrc.includes('updateSubtypeRate')
);

console.log('\n--- Governed Acceptance Regressions: lookupRate ---');

// Mock company rate sheets with governed multi-family configuration
const mockRateSheets = {
  'Chord Energy': [
    // Primary family 1: Production % (per_bbl)
    { jobType: 'Production %', method: 'per_bbl', rate: 2.50 },
    // Primary family 2: Service Work (hourly) with Standby exception $80/hr
    {
      jobType: 'Service Work',
      method: 'hourly',
      rate: 155.00,
      subtypeRates: {
        Standby: 80.00,
        Inspection: 110.00,
      },
    },
    // Primary family 3: Rig Work (hourly) with different Standby exception $95/hr
    {
      jobType: 'Rig Work',
      method: 'hourly',
      rate: 180.00,
      subtypeRates: {
        Standby: 95.00,
      },
    },
    // Primary family 4: Vac Work (hourly) with base rate $140/hr
    {
      jobType: 'Vac Work',
      method: 'hourly',
      rate: 140.00,
    },
    // Standalone subtype entry with EXPLICIT primary association to Vac Work
    {
      jobType: 'Standby',
      method: 'hourly',
      rate: 85.00,
      primaryJobType: 'Vac Work',
    },
    // Standalone UNASSOCIATED entry (must never be selected as cross-family override)
    {
      jobType: 'GenericStandby',
      method: 'hourly',
      rate: 50.00,
    },
  ],
  'Civitas': [
    {
      jobType: 'Service Work',
      method: 'hourly',
      rate: 160.00,
      // Civitas has no standby exception configured
    },
    {
      jobType: 'Production Water',
      method: 'per_bbl',
      rate: 2.75,
    },
  ],
};

// Regression Case 1: Service Work / Standby configured $80/hr
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'Standby');
  check('Case 1: Service Work / Standby resolves configured exception ($80.00)', entry?.rate === 80.00);
  check('Case 1: Service Work / Standby preserves hourly method', entry?.method === 'hourly');
}

// Regression Case 2: Service Work / unconfigured subtype full hourly ($155/hr)
{
  const entryNoSub = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work');
  check('Case 2a: Service Work with absent subtype resolves full hourly rate ($155.00)', entryNoSub?.rate === 155.00);
  check('Case 2a: preserves hourly method', entryNoSub?.method === 'hourly');

  const entryEmpty = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', '');
  check('Case 2b: Service Work with empty subtype resolves full hourly rate ($155.00)', entryEmpty?.rate === 155.00);

  const entryNull = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', null);
  check('Case 2c: Service Work with null subtype resolves full hourly rate ($155.00)', entryNull?.rate === 155.00);

  const entryUnmatched = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'Rig Wash');
  check('Case 2d: Service Work with unmatched subtype "Rig Wash" falls back to full rate ($155.00)', entryUnmatched?.rate === 155.00);

  const entryCivitas = lookupRate(mockRateSheets, 'Civitas', 'Service Work', 'Standby');
  check('Case 2e: Civitas Service Work (no Standby configured) falls back to full rate ($160.00)', entryCivitas?.rate === 160.00);
}

// Regression Case 3: Missing or unknown primary with Standby -> returns null
{
  const entryMissing = lookupRate(mockRateSheets, 'Chord Energy', '', 'Standby');
  check('Case 3a: Empty primary jobType with Standby returns null', entryMissing === null);

  const entryWhitespace = lookupRate(mockRateSheets, 'Chord Energy', '   ', 'Standby');
  check('Case 3b: Whitespace primary jobType with Standby returns null', entryWhitespace === null);

  const entryUnknown = lookupRate(mockRateSheets, 'Chord Energy', 'NonExistentJob', 'Standby');
  check('Case 3c: Unknown primary jobType with Standby returns null', entryUnknown === null);

  const entryGenericSubOnly = lookupRate(mockRateSheets, 'Chord Energy', '', 'GenericStandby');
  check('Case 3d: Standalone unassociated entry is NOT selected when primary is missing', entryGenericSubOnly === null);
}

// Regression Case 4: Production % / Standby when only Service Work has a Standby exception
{
  const entryProd = lookupRate(mockRateSheets, 'Chord Energy', 'Production %', 'Standby');
  check('Case 4a: Production % with Standby does NOT adopt Service Work standby rate ($2.50/bbl)', entryProd?.rate === 2.50);
  check('Case 4b: Production % strictly keeps per_bbl method (not converted to hourly)', entryProd?.method === 'per_bbl');

  // Also test legacy alias matching: 'Production Water' matches 'Production %'
  const entryProdAlias = lookupRate(mockRateSheets, 'Chord Energy', 'Production Water', 'Standby');
  check('Case 4c: Production Water alias with Standby keeps per_bbl rate ($2.50/bbl)', entryProdAlias?.rate === 2.50);
  check('Case 4d: Production Water alias keeps per_bbl method', entryProdAlias?.method === 'per_bbl');
}

// Regression Case 5: Two primary families using different Standby exceptions for the same operator
{
  const entrySW = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'Standby');
  const entryRig = lookupRate(mockRateSheets, 'Chord Energy', 'Rig Work', 'Standby');
  check('Case 5a: Same operator Service Work / Standby resolves $80.00', entrySW?.rate === 80.00);
  check('Case 5b: Same operator Rig Work / Standby resolves $95.00', entryRig?.rate === 95.00);
  check('Case 5c: Service Work and Rig Work Standby exceptions remain distinct', entrySW?.rate !== entryRig?.rate);
}

// Regression Case 6: Explicit standalone association (primaryJobType)
{
  // Vac Work has a standalone entry with primaryJobType: 'Vac Work' -> $85.00
  const entryVac = lookupRate(mockRateSheets, 'Chord Energy', 'Vac Work', 'Standby');
  check('Case 6a: Vac Work matches standalone entry with explicit primary association ($85.00)', entryVac?.rate === 85.00);
  check('Case 6b: Vac Work preserves method hourly', entryVac?.method === 'hourly');

  // Service Work does NOT adopt Vac Work's standalone entry
  const entrySW_unmatched = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'UnmatchedSub');
  check('Case 6c: Service Work does not adopt Vac Work standalone entry ($155.00)', entrySW_unmatched?.rate === 155.00);

  // GenericStandby has no primaryJobType: must never override Service Work
  const entrySW_generic = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'GenericStandby');
  check('Case 6d: Generic unassociated standalone entry does not override Service Work ($155.00)', entrySW_generic?.rate === 155.00);
}

// Case 7: Case-insensitive matching
{
  const lower = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'standby');
  check('Case 7a: Lowercase "standby" matches ($80.00)', lower?.rate === 80.00);

  const upper = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'STANDBY');
  check('Case 7b: Uppercase "STANDBY" matches ($80.00)', upper?.rate === 80.00);
}

console.log('\n--- Timesheet Re-rate Path: applyRatesToTimesheet ---');

// Mock timesheet summary with multi-family rows
const mockSummary = {
  driverName: 'Jane Smith',
  companyId: 'comp-1',
  truckNumber: '202',
  totalLoads: 4,
  totalHours: 19.0,
  totalBBLs: 120,
  grossBilled: 0,
  employeePay: 0,
  deductions: 0,
  additions: 0,
  netPay: 0,
  status: 'building',
  rows: [
    {
      id: 'row-1',
      date: '2026-10-01',
      invoiceNumber: 'INV-201',
      operator: 'Chord Energy',
      wellName: 'Well A',
      jobType: 'Service Work',
      subjob: undefined, // no subjob -> $155/hr
      bbls: 0,
      hours: 4.0,
      rate: 0,
      amountBilled: 0,
      detentionPay: 0,
      swdWaitMinutes: 0,
      employeeTake: 0,
      tickets: ['3001'],
    },
    {
      id: 'row-2',
      date: '2026-10-01',
      invoiceNumber: 'INV-202',
      operator: 'Chord Energy',
      wellName: 'Well B',
      jobType: 'Service Work',
      subjob: 'Standby', // Standby exception -> $80/hr
      bbls: 0,
      hours: 5.0,
      rate: 0,
      amountBilled: 0,
      detentionPay: 0,
      swdWaitMinutes: 0,
      employeeTake: 0,
      tickets: ['3002'],
    },
    {
      id: 'row-3',
      date: '2026-10-01',
      invoiceNumber: 'INV-203',
      operator: 'Chord Energy',
      wellName: 'Well C',
      jobType: 'Rig Work',
      subjob: 'Standby', // Rig Work Standby exception -> $95/hr
      bbls: 0,
      hours: 4.0,
      rate: 0,
      amountBilled: 0,
      detentionPay: 0,
      swdWaitMinutes: 0,
      employeeTake: 0,
      tickets: ['3003'],
    },
    {
      id: 'row-4',
      date: '2026-10-01',
      invoiceNumber: 'INV-204',
      operator: 'Chord Energy',
      wellName: 'Well D',
      jobType: 'Production %',
      subjob: 'Standby', // Production % with Standby -> remains per_bbl $2.50/bbl (120 bbls = $300)
      bbls: 120,
      hours: 6.0,
      rate: 0,
      amountBilled: 0,
      detentionPay: 0,
      swdWaitMinutes: 0,
      employeeTake: 0,
      tickets: ['3004'],
    },
  ],
};

const updated = applyRatesToTimesheet(mockSummary, mockRateSheets, 0.25);

// Check row 1: 4 hrs * $155/hr = $620, employeeTake = $155 (25%)
const r1 = updated.rows.find(r => r.id === 'row-1');
check('Row 1 (Service Work, no subjob): rate $155/hr', r1?.rate === 155.00);
check('Row 1 amountBilled $620.00', r1?.amountBilled === 620.00);
check('Row 1 employeeTake $155.00', r1?.employeeTake === 155.00);

// Check row 2: 5 hrs * $80/hr = $400, employeeTake = $100 (25%)
const r2 = updated.rows.find(r => r.id === 'row-2');
check('Row 2 (Service Work, Standby): rate $80/hr', r2?.rate === 80.00);
check('Row 2 amountBilled $400.00', r2?.amountBilled === 400.00);
check('Row 2 employeeTake $100.00', r2?.employeeTake === 100.00);

// Check row 3: 4 hrs * $95/hr = $380, employeeTake = $95 (25%)
const r3 = updated.rows.find(r => r.id === 'row-3');
check('Row 3 (Rig Work, Standby): rate $95/hr', r3?.rate === 95.00);
check('Row 3 amountBilled $380.00', r3?.amountBilled === 380.00);
check('Row 3 employeeTake $95.00', r3?.employeeTake === 95.00);

// Check row 4: 120 bbls * $2.50 = $300, employeeTake = $75.00 (25%)
const r4 = updated.rows.find(r => r.id === 'row-4');
check('Row 4 (Production %, Standby): rate $2.50/bbl', r4?.rate === 2.50);
check('Row 4 amountBilled $300.00 (per_bbl, not hourly)', r4?.amountBilled === 300.00);
check('Row 4 employeeTake $75.00', r4?.employeeTake === 75.00);

// Summary totals
// Gross: 620 + 400 + 380 + 300 = 1700.00
// Employee Pay: 155 + 100 + 95 + 75 = 425.00
check('Summary grossBilled calculates correctly ($1700.00)', updated.grossBilled === 1700.00);
check('Summary employeePay calculates correctly ($425.00)', updated.employeePay === 425.00);

console.log(`\n========================================`);
console.log(`Total checks: ${pass + fail} | Passed: ${pass} | Failed: ${fail}`);
console.log(`========================================`);

if (fail > 0) {
  process.exit(1);
}
