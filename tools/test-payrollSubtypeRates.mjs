/**
 * test-payrollSubtypeRates.mjs
 *
 * Verifies Dashboard Payroll subtype rate logic and source contracts:
 * 1. commodityType (primary jobType) and subjob operate as separate variables.
 * 2. Full hourly rate applies when subjob is absent, empty, or unmatched.
 * 3. Configured subtype rate exception applies when subjob matches subtypeRates (e.g. Standby at $80/hr).
 * 4. Subtype matching is case-insensitive.
 * 5. Subtype exceptions are configurable per company/operator.
 * 6. applyRatesToTimesheet applies subtype rate exceptions to rows containing subjob.
 * 7. Source contracts verified in companySettings.ts, payroll.ts, billing.ts, and RateSheetsCard.tsx.
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
  'companySettings.ts: RateEntry defines optional subtypeRates map',
  /subtypeRates\?:\s*Record<string,\s*number>;/.test(companySettingsSrc)
);

check(
  'payroll.ts: RateEntry defines optional subtypeRates map',
  /subtypeRates\?:\s*Record<string,\s*number>;/.test(payrollSrc)
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
  'payroll.ts: lookupRate checks baseEntry.subtypeRates before returning',
  payrollSrc.includes('baseEntry.subtypeRates') &&
  payrollSrc.includes('cleanSubLower')
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

console.log('\n--- Runtime Logic: lookupRate Behavioral Tests ---');

// Mock company rate sheets
const mockRateSheets = {
  'Chord Energy': [
    { jobType: 'Production %', method: 'per_bbl', rate: 2.50 },
    {
      jobType: 'Service Work',
      method: 'hourly',
      rate: 155.00,
      subtypeRates: {
        Standby: 80.00,
        Inspection: 110.00,
      },
    },
  ],
  'Civitas': [
    {
      jobType: 'Service Work',
      method: 'hourly',
      rate: 160.00,
      // Civitas has no standby exception configured
    },
  ],
  'Continental': [
    {
      jobType: 'Service Work',
      method: 'hourly',
      rate: 150.00,
    },
    // Continental configured Standby as an explicit operator-level rate entry
    {
      jobType: 'Standby',
      method: 'hourly',
      rate: 75.00,
    },
  ],
};

// 1. Standard primary job without subjob -> returns full rate
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work');
  check('Absent subjob returns base hourly rate ($155.00)', entry?.rate === 155.00);
}

// 2. Empty string subjob -> returns full rate
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', '');
  check('Empty subjob returns base hourly rate ($155.00)', entry?.rate === 155.00);
}

// 3. Null subjob -> returns full rate
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', null);
  check('Null subjob returns base hourly rate ($155.00)', entry?.rate === 155.00);
}

// 4. Unmatched subjob -> returns full rate
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'Rig Wash');
  check('Unmatched subjob falls back to base hourly rate ($155.00)', entry?.rate === 155.00);
}

// 5. Configured subtype rate exception matched (exact case) -> returns subtype rate
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'Standby');
  check('Matched subjob "Standby" returns subtype rate ($80.00)', entry?.rate === 80.00);
  check('Subtype entry preserves method hourly', entry?.method === 'hourly');
}

// 6. Configured subtype rate exception matched (case-insensitive lowercase)
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'standby');
  check('Lowercase subjob "standby" matches case-insensitively ($80.00)', entry?.rate === 80.00);
}

// 7. Configured subtype rate exception matched (case-insensitive uppercase)
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'STANDBY');
  check('Uppercase subjob "STANDBY" matches case-insensitively ($80.00)', entry?.rate === 80.00);
}

// 8. Another subtype rate exception (Inspection)
{
  const entry = lookupRate(mockRateSheets, 'Chord Energy', 'Service Work', 'Inspection');
  check('Matched subjob "Inspection" returns subtype rate ($110.00)', entry?.rate === 110.00);
}

// 9. Operator-specific configurability: Civitas does not configure Standby exception
{
  const entry = lookupRate(mockRateSheets, 'Civitas', 'Service Work', 'Standby');
  check('Civitas (no Standby exception) falls back to base rate ($160.00)', entry?.rate === 160.00);
}

// 10. Operator explicit subjob entry fallback: Continental
{
  const entry = lookupRate(mockRateSheets, 'Continental', 'Service Work', 'Standby');
  check('Continental explicit Standby entry matched ($75.00)', entry?.rate === 75.00);
}

console.log('\n--- Runtime Logic: applyRatesToTimesheet Behavioral Tests ---');

// Mock timesheet summary
const mockSummary = {
  driverName: 'John Doe',
  companyId: 'comp-1',
  truckNumber: '101',
  totalLoads: 4,
  totalHours: 18.0,
  totalBBLs: 100,
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
      invoiceNumber: 'INV-101',
      operator: 'Chord Energy',
      wellName: 'Kahuna 1',
      jobType: 'Service Work',
      subjob: undefined, // no subjob
      bbls: 0,
      hours: 4.0,
      rate: 0,
      amountBilled: 0,
      detentionPay: 0,
      swdWaitMinutes: 0,
      employeeTake: 0,
      tickets: ['20511'],
    },
    {
      id: 'row-2',
      date: '2026-10-01',
      invoiceNumber: 'INV-102',
      operator: 'Chord Energy',
      wellName: 'Kahuna 2',
      jobType: 'Service Work',
      subjob: 'Standby', // standby subtype exception -> $80/hr
      bbls: 0,
      hours: 5.0,
      rate: 0,
      amountBilled: 0,
      detentionPay: 0,
      swdWaitMinutes: 0,
      employeeTake: 0,
      tickets: ['20512'],
    },
    {
      id: 'row-3',
      date: '2026-10-01',
      invoiceNumber: 'INV-103',
      operator: 'Chord Energy',
      wellName: 'Kahuna 3',
      jobType: 'Service Work',
      subjob: 'UnmatchedSpecial', // unmatched subjob -> falls back to $155/hr
      bbls: 0,
      hours: 3.0,
      rate: 0,
      amountBilled: 0,
      detentionPay: 0,
      swdWaitMinutes: 0,
      employeeTake: 0,
      tickets: ['20513'],
    },
    {
      id: 'row-4',
      date: '2026-10-01',
      invoiceNumber: 'INV-104',
      operator: 'Chord Energy',
      wellName: 'Kahuna 4',
      jobType: 'Production %',
      subjob: undefined,
      bbls: 100,
      hours: 6.0,
      rate: 0,
      amountBilled: 0,
      detentionPay: 0,
      swdWaitMinutes: 0,
      employeeTake: 0,
      tickets: ['20514'],
    },
  ],
};

const updated = applyRatesToTimesheet(mockSummary, mockRateSheets, 0.25);

// Check row 1: 4 hrs * $155/hr = $620, employeeTake = $155 (25%)
const r1 = updated.rows.find(r => r.id === 'row-1');
check('Row 1 (no subjob): rate is $155/hr', r1?.rate === 155.00);
check('Row 1 (no subjob): amountBilled is $620.00', r1?.amountBilled === 620.00);
check('Row 1 (no subjob): employeeTake is $155.00 (25%)', r1?.employeeTake === 155.00);

// Check row 2: 5 hrs * $80/hr = $400, employeeTake = $100 (25%)
const r2 = updated.rows.find(r => r.id === 'row-2');
check('Row 2 (Standby subjob): rate is $80/hr', r2?.rate === 80.00);
check('Row 2 (Standby subjob): amountBilled is $400.00', r2?.amountBilled === 400.00);
check('Row 2 (Standby subjob): employeeTake is $100.00 (25%)', r2?.employeeTake === 100.00);

// Check row 3: 3 hrs * $155/hr = $465, employeeTake = $116.25 (25%)
const r3 = updated.rows.find(r => r.id === 'row-3');
check('Row 3 (unmatched subjob): rate is $155/hr', r3?.rate === 155.00);
check('Row 3 (unmatched subjob): amountBilled is $465.00', r3?.amountBilled === 465.00);
check('Row 3 (unmatched subjob): employeeTake is $116.25 (25%)', r3?.employeeTake === 116.25);

// Check row 4: 100 bbls * $2.50 = $250, employeeTake = $62.50 (25%)
const r4 = updated.rows.find(r => r.id === 'row-4');
check('Row 4 (Production % per_bbl): rate is $2.50/bbl', r4?.rate === 2.50);
check('Row 4 (Production % per_bbl): amountBilled is $250.00', r4?.amountBilled === 250.00);
check('Row 4 (Production % per_bbl): employeeTake is $62.50 (25%)', r4?.employeeTake === 62.50);

// Summary totals
const expectedGross = 620.00 + 400.00 + 465.00 + 250.00; // 1735.00
const expectedEmployeePay = 155.00 + 100.00 + 116.25 + 62.50; // 433.75
check('Summary grossBilled calculates correctly ($1735.00)', updated.grossBilled === expectedGross);
check('Summary employeePay calculates correctly ($433.75)', updated.employeePay === expectedEmployeePay);

console.log(`\n========================================`);
console.log(`Total checks: ${pass + fail} | Passed: ${pass} | Failed: ${fail}`);
console.log(`========================================`);

if (fail > 0) {
  process.exit(1);
}
