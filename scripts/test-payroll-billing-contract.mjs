/**
 * Payroll/Billing shared completed-job contract.
 *
 * Business invariant: PayrollEligible(J) == BillingEligible(J) for every
 * completed job J. Monetary calculations may differ; the canonical
 * inclusion/exclusion decision and the service date must not drift.
 *
 * Field evidence driving this: jobs 19838–19841 (offline-replay-created
 * invoices with no `date` field) appeared in both consumers with blank
 * dates; Billing silently dropped operator-less docs Payroll kept; Billing's
 * rate date fell back to the UTC calendar day of createdAt (off-by-one for
 * evening closes in America/Chicago) while Payroll used no fallback at all.
 *
 * Run: node scripts/test-payroll-billing-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isPayrollBillingEligible,
  invoiceServiceDate,
  normalizeToYMD,
  MISSING_OPERATOR_LABEL,
} from '../src/lib/payrollBillingContract.ts';

function expect(cond, msg, extra) {
  if (!cond) throw new Error(`${msg}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
let section = 0;
const pass = (name) => console.log(`  ✓ [${++section}] ${name}`);

const ts = (iso) => ({ toDate: () => new Date(iso) }); // Firestore Timestamp stand-in

// Fixture set — the exact cases the contract must decide identically for
// Payroll and Billing.
const FIXTURES = {
  properDated: { status: 'closed', companyId: 'liquid-gold', operator: 'SLAWSON', date: '07/23/2026', createdAt: ts('2026-07-23T17:39:34.049Z') },
  undatedLegacy: { status: 'closed', companyId: 'liquid-gold', operator: 'SLAWSON', createdAt: ts('2026-07-23T22:17:05.218Z') },
  missingCompany: { status: 'closed', operator: 'SLAWSON', date: '07/20/2026', createdAt: ts('2026-07-20T12:00:00Z') },
  crossTenant: { status: 'closed', companyId: 'other-co', operator: 'SLAWSON', date: '07/20/2026', createdAt: ts('2026-07-20T12:00:00Z') },
  cancelled: { status: 'cancelled', companyId: 'liquid-gold', operator: 'SLAWSON', date: '07/20/2026' },
  voided: { status: 'void', companyId: 'liquid-gold', operator: 'SLAWSON', date: '07/20/2026' },
  open: { status: 'open', companyId: 'liquid-gold', operator: 'SLAWSON', date: '07/20/2026' },
  missingOperator: { status: 'closed', companyId: 'liquid-gold', date: '07/22/2026', createdAt: ts('2026-07-22T12:00:00Z') },
  offlineReplay: { status: 'closed', companyId: 'liquid-gold', operator: 'SLAWSON', date: '07/23/2026', createdAt: ts('2026-07-24T03:10:00.000Z') }, // replayed after midnight UTC
  splitContinuation: { status: 'closed', companyId: 'liquid-gold', operator: 'SLAWSON', date: '07/23/2026', invoiceNumber: '19840-B', createdAt: ts('2026-07-23T21:00:00Z') },
};

// ── 1. Inclusion decisions — one function, both consumers ────────────────────
{
  const scoped = { companyId: 'liquid-gold' };
  const expected = {
    properDated: true,
    undatedLegacy: true,        // missing date NEVER drops a completed job
    missingCompany: false,      // scoped tenant cannot see unstamped docs
    crossTenant: false,
    cancelled: false,
    voided: false,
    open: false,
    missingOperator: true,      // surfaced as a data problem, not silently lost
    offlineReplay: true,
    splitContinuation: true,
  };
  for (const [name, doc] of Object.entries(FIXTURES)) {
    expect(isPayrollBillingEligible(doc, scoped) === expected[name],
      `scoped eligibility(${name}) === ${expected[name]}`);
  }
  // Platform admin (no tenant scope) sees everything not open/cancelled/void.
  expect(isPayrollBillingEligible(FIXTURES.missingCompany, {}) === true,
    'platform admin includes unstamped docs');
  expect(isPayrollBillingEligible(FIXTURES.crossTenant, {}) === true,
    'platform admin includes other tenants');
  pass('inclusion: identical decision set for all ten fixtures (scoped + global)');
}

// ── 2. Service date — canonical first, marked fallback second ────────────────
{
  const proper = invoiceServiceDate(FIXTURES.properDated, 'America/Chicago');
  expect(proper.ymd === '2026-07-23' && proper.source === 'invoice_date' && proper.fallback === false,
    'canonical invoice date preferred', proper);

  const undated = invoiceServiceDate(FIXTURES.undatedLegacy, 'America/Chicago');
  expect(undated.ymd === '2026-07-23' && undated.source === 'created_at_fallback' && undated.fallback === true,
    'createdAt fallback is business-timezone civil day, marked as fallback', undated);

  // 2026-07-24T03:10Z = 2026-07-23 22:10 CDT — UTC day would be the 24th.
  const replayNoDate = invoiceServiceDate({ createdAt: ts('2026-07-24T03:10:00.000Z') }, 'America/Chicago');
  expect(replayNoDate.ymd === '2026-07-23',
    'fallback uses business timezone, not UTC (evening close stays on its day)', replayNoDate);

  // Replay never overrides a present canonical date.
  const replay = invoiceServiceDate(FIXTURES.offlineReplay, 'America/Chicago');
  expect(replay.ymd === '2026-07-23' && replay.fallback === false,
    'offline replay keeps the canonical service day');

  const none = invoiceServiceDate({}, 'America/Chicago');
  expect(none.ymd === '' && none.source === 'none' && none.fallback === false,
    'no date evidence stays explicit, never fabricated');
  pass('service date: canonical > marked business-tz fallback > explicit none');
}

// ── 3. normalizeToYMD shared (rate-effective dates cannot drift) ─────────────
{
  expect(normalizeToYMD('07/23/2026') === '2026-07-23', 'MM/DD/YYYY normalized');
  expect(normalizeToYMD('2026-07-23') === '2026-07-23', 'YMD passthrough');
  expect(normalizeToYMD('') === '', 'empty stays empty');
  pass('one shared date normalizer');
}

// ── 4. Missing operator: surfaced, never silently lost ───────────────────────
{
  expect(typeof MISSING_OPERATOR_LABEL === 'string' && MISSING_OPERATOR_LABEL.length > 0,
    'sentinel label exists');
  const billing = read('src/lib/billing.ts');
  expect(!/if \(!operator\) return;/.test(billing),
    'Billing no longer drops operator-less completed jobs');
  expect(billing.includes('MISSING_OPERATOR_LABEL'),
    'Billing groups them under the sentinel (actionable data problem)');
  pass('missing operator is an actionable data problem in Billing, kept in Payroll');
}

// ── 5. Both consumers wired through the contract ─────────────────────────────
{
  const payroll = read('src/lib/payroll.ts');
  const billing = read('src/lib/billing.ts');
  for (const [name, src] of [['payroll', payroll], ['billing', billing]]) {
    expect(src.includes('isPayrollBillingEligible'),
      `${name} uses the shared eligibility decision`);
    expect(src.includes('invoiceServiceDate'),
      `${name} uses the shared service date`);
    expect(!/status === 'open' \|\| status === 'cancelled' \|\| status === 'void'/.test(src),
      `${name} has no duplicated inline eligibility logic`);
  }
  // Rate-effective date parity: both feed the shared ymd into getEffectiveRate.
  const payrollRateCall = payroll.slice(payroll.indexOf('getEffectiveRate(rateEntry'));
  expect(/serviceDate\.ymd|svcDate\.ymd/.test(payrollRateCall.slice(0, 200)),
    'payroll rate date comes from the shared service date');
  const billingRateCall = billing.slice(billing.indexOf('getEffectiveRate(rateEntry'));
  expect(/serviceDate\.ymd|svcDate\.ymd|invoiceDate/.test(billingRateCall.slice(0, 200)),
    'billing rate date comes from the shared service date');
  expect(!/createdAt\?\.toDate\?\.\(\)\?\.toISOString/.test(billing),
    'billing UTC-day fallback removed (business-timezone via contract)');
  pass('payroll + billing share eligibility and service date (no drift left to happen)');
}

// ── 6. Fallback dates are marked for diagnosis ───────────────────────────────
{
  const payroll = read('src/lib/payroll.ts');
  const billing = read('src/lib/billing.ts');
  expect(/dateSource/.test(payroll) && /dateSource/.test(billing),
    'rows carry dateSource so fallback-derived dates are diagnosable');
  pass('fallback-derived dates are marked, not silently blended');
}

console.log(`\ntest-payroll-billing-contract: ALL ${section} SECTIONS PASSED`);
