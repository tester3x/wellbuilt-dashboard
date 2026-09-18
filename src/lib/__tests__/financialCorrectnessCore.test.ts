/**
 * Financial correctness: characterization of pre-fix behavior, then golden v1.
 * Run: node --test --experimental-strip-types src/lib/__tests__/financialCorrectnessCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_JOB_TYPE_ALIASES,
  FINANCIAL_CORRECTNESS_CONTRACT_VERSION,
  hoursColumnHeader,
  hoursDisplay,
  isFinanciallyEligibleStatus,
  mixedQuantitySummary,
  moneyDisplay,
  projectFinancialLine,
  quantityColumnHeader,
  quantityDisplay,
  resolveEmployeeSplit,
  resolveFinancialQuantity,
  resolveFinancialRate,
  resolveFinancialTime,
  type CompanyRateSheets,
  type FinancialRateEntry,
} from '../financialCorrectnessCore.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'financialGoldenFixtures.v1.json');
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));

// ── Characterization of PRE-FIX Dashboard behavior (frozen copies) ───────────

function legacyDashboardSkip(status: unknown): boolean {
  const s = (status as string) || 'open';
  return s === 'open' || s === 'cancelled' || s === 'void';
}

function legacyDashboardLookupRate(
  rateSheets: Record<string, FinancialRateEntry[]>,
  operator: string,
  jobType: string,
): FinancialRateEntry | null {
  const operatorRates = rateSheets[operator];
  if (!operatorRates) return null;
  const direct = operatorRates.find(r => r.jobType === jobType);
  if (direct) return direct;
  for (const entry of operatorRates) {
    const normalizedEntry = CANONICAL_JOB_TYPE_ALIASES[entry.jobType] || entry.jobType;
    const normalizedJob = CANONICAL_JOB_TYPE_ALIASES[jobType] || jobType;
    if (normalizedEntry === jobType || entry.jobType === normalizedJob || normalizedEntry === normalizedJob) {
      return entry;
    }
  }
  return null;
}

function legacyDashboardQty(d: { totalBBL?: number; bbls?: string; qty?: string }): number {
  return d.totalBBL || parseFloat(d.bbls || '0') || parseFloat(d.qty || '0') || 0;
}

test('characterization: Dashboard skip allows in_progress and paused into money', () => {
  assert.equal(legacyDashboardSkip('open'), true);
  assert.equal(legacyDashboardSkip('cancelled'), true);
  assert.equal(legacyDashboardSkip('void'), true);
  assert.equal(legacyDashboardSkip('in_progress'), false);
  assert.equal(legacyDashboardSkip('paused'), false);
  assert.equal(legacyDashboardSkip(undefined), true);
  // Pre-fix also billed post-close workflow states (must remain eligible).
  assert.equal(legacyDashboardSkip('submitted'), false);
  assert.equal(legacyDashboardSkip('approved'), false);
  assert.equal(legacyDashboardSkip('paid'), false);
});

test('characterization: Dashboard lookupRate is order-dependent on duplicates and returns null on no match', () => {
  const dup: Record<string, FinancialRateEntry[]> = {
    Acme: [
      { jobType: 'Production Water', method: 'per_bbl', rate: 2.4 },
      { jobType: 'Production Water', method: 'per_bbl', rate: 9.9 },
    ],
  };
  assert.equal(legacyDashboardLookupRate(dup, 'Acme', 'Production Water')!.rate, 2.4);
  const reversed = { Acme: [...dup.Acme].reverse() };
  assert.equal(legacyDashboardLookupRate(reversed, 'Acme', 'Production Water')!.rate, 9.9);
  assert.equal(legacyDashboardLookupRate({ Acme: [{ jobType: 'Service Work', method: 'hourly', rate: 150 }] }, 'Acme', 'Skim Oil'), null);
});

test('characterization: Dashboard qty treats untyped qty as BBL', () => {
  assert.equal(legacyDashboardQty({ qty: '40' }), 40);
  assert.equal(legacyDashboardQty({ totalBBL: 185 }), 185);
});

// ── Required contract ────────────────────────────────────────────────────────

test('contract version is 1.0.0', () => {
  assert.equal(FINANCIAL_CORRECTNESS_CONTRACT_VERSION, '1.0.0');
  assert.equal(fixtures.contractVersion, '1.0.0');
});

test('golden statuses: only closed/completed/submitted/approved/paid are eligible', () => {
  for (const row of fixtures.statuses) {
    const got = isFinanciallyEligibleStatus(row.status);
    assert.equal(got.eligible, row.expectEligible, row.id);
  }
});

function sheetOf(name: string): CompanyRateSheets {
  if (name === 'empty') return {};
  return fixtures[name] as CompanyRateSheets;
}

test('golden rates: exact, no-match, empty, reorder, zero, ambiguous', () => {
  for (const row of fixtures.rateCases) {
    const got = resolveFinancialRate(sheetOf(row.sheet), row.operator, row.jobType);
    assert.equal(got.state, row.expectState, row.id);
    if (row.expectReason) {
      assert.equal((got as { reason?: string }).reason, row.expectReason, row.id);
    }
    if (row.expectRate !== undefined && (got.state === 'resolved' || got.state === 'explicit_zero')) {
      assert.equal(got.entry.rate, row.expectRate, row.id);
    }
  }
});

test('rate array order does not change exact match', () => {
  const a = resolveFinancialRate(fixtures.rateSheet, 'Acme', 'Production Water');
  const b = resolveFinancialRate(fixtures.rateSheetReordered, 'Acme', 'Production Water');
  assert.equal(a.state, 'resolved');
  assert.equal(b.state, 'resolved');
  if (a.state === 'resolved' && b.state === 'resolved') {
    assert.equal(a.entry.rate, b.entry.rate);
  }
});

test('golden splits', () => {
  for (const row of fixtures.splitCases) {
    const got = resolveEmployeeSplit(row.raw);
    assert.equal(got.state, row.expectState, row.id);
    if (row.expectSplit !== undefined && (got.state === 'resolved' || got.state === 'explicit_zero')) {
      assert.equal(got.split, row.expectSplit, row.id);
    }
  }
});

test('golden quantities', () => {
  for (const row of fixtures.quantityCases) {
    const got = resolveFinancialQuantity(row.facts);
    assert.equal(got.state, row.expectState, row.id);
    if (row.expectReason) assert.equal((got as { reason?: string }).reason, row.expectReason, row.id);
    if (row.expectUnit && got.state !== 'unresolved') assert.equal(got.unit, row.expectUnit, row.id);
    if (row.expectValue !== undefined && got.state !== 'unresolved') assert.equal(got.value, row.expectValue, row.id);
  }
});

test('tons are never labeled or priced as BBL', () => {
  const q = resolveFinancialQuantity({ tons: 22.5 });
  assert.equal(q.state, 'resolved');
  if (q.state !== 'unresolved') assert.equal(q.unit, 'ton');
  assert.equal(quantityDisplay(q).includes('BBL'), false);
  assert.equal(quantityColumnHeader('ton'), 'Tons');
  const line = projectFinancialLine({
    status: 'closed',
    operator: 'Acme',
    jobType: 'Production Water',
    quantity: { tons: 22.5 },
    time: {},
    rateSheets: fixtures.rateSheet,
    defaultSplit: 0.25,
  });
  assert.equal(line.amountBilled, null);
  assert.equal(line.amountReason, 'qty:unsupported_unit_for_per_bbl');
  assert.equal(line.qtyForBblColumn, null);
  assert.equal(line.qtyForTonColumn, 22.5);
});

test('golden time provenance: raw survives allocation; legacy labeled', () => {
  for (const row of fixtures.timeCases) {
    const got = resolveFinancialTime(row.facts);
    assert.equal(got.provenance, row.expectProvenance, row.id);
    assert.equal(got.observedHours, row.expectObserved, row.id);
    assert.equal(got.allocatedHours, row.expectAllocated, row.id);
    assert.equal(got.financialHours, row.expectFinancial, row.id);
  }
  const split = resolveFinancialTime({ observedHours: 10, allocatedHours: 5, allocationMethod: 'equal' });
  assert.equal(split.observedHours, 10);
  assert.equal(split.allocatedHours, 5);
  assert.equal(hoursDisplay(split), '5 allocated (equal) · 10 observed');
  assert.equal(hoursColumnHeader('allocated'), 'Allocated hours');
  assert.equal(hoursColumnHeader('legacy_unknown'), 'Hours (legacy/unknown)');
  const raw = resolveFinancialTime({ observedHours: 10 });
  assert.equal(hoursDisplay(raw), '10 observed');
  const legacy = resolveFinancialTime({ totalHours: 8 });
  assert.equal(hoursDisplay(legacy), '8 (legacy/unknown provenance)');
});

test('ineligible statuses never produce billed amount', () => {
  for (const status of ['open', 'in_progress', 'in-progress', 'paused', 'cancelled', 'void', 'transferred', 'transfer_pending', null, 'mystery']) {
    const line = projectFinancialLine({
      status,
      operator: 'Acme',
      jobType: 'Production Water',
      quantity: { totalBBL: 100 },
      time: { totalHours: 2 },
      rateSheets: fixtures.rateSheet,
      defaultSplit: 0.25,
    });
    assert.equal(line.eligible.eligible, false, String(status));
    assert.equal(line.amountBilled, null, String(status));
  }
});

test('post-close invoice workflow states remain eligible and bill', () => {
  for (const status of ['closed', 'completed', 'submitted', 'approved', 'paid']) {
    const line = projectFinancialLine({
      status,
      operator: 'Acme',
      jobType: 'Production Water',
      quantity: { totalBBL: 100 },
      time: { totalHours: 2 },
      rateSheets: fixtures.rateSheet,
      defaultSplit: 0.25,
    });
    assert.equal(line.eligible.eligible, true, String(status));
    assert.equal(line.amountBilled, 240, String(status));
  }
});

test('closed BBL load with exact rate bills; missing rate stays unresolved not zero', () => {
  const ok = projectFinancialLine({
    status: 'closed',
    operator: 'Acme',
    jobType: 'Production Water',
    quantity: { totalBBL: 100 },
    time: { totalHours: 2 },
    rateSheets: fixtures.rateSheet,
    defaultSplit: 0.25,
  });
  assert.equal(ok.amountBilled, 240);
  assert.equal(ok.employeeTake, 60);
  const missing = projectFinancialLine({
    status: 'closed',
    operator: 'Acme',
    jobType: 'Skim Oil',
    quantity: { totalBBL: 100 },
    time: {},
    rateSheets: fixtures.rateSheet,
    defaultSplit: 0.25,
  });
  assert.equal(missing.amountBilled, null);
  assert.equal(moneyDisplay(missing.amountBilled, missing.amountReason).startsWith('UNRESOLVED'), true);
});

test('report helpers never put tons under a BBL heading', () => {
  assert.equal(quantityColumnHeader('bbl'), 'BBLs');
  assert.equal(quantityColumnHeader('ton'), 'Tons');
  assert.notEqual(quantityColumnHeader('ton'), quantityColumnHeader('bbl'));
  assert.equal(mixedQuantitySummary(100, 0), '100 BBL');
  assert.equal(mixedQuantitySummary(0, 12), '12 ton');
  assert.equal(mixedQuantitySummary(100, 12), '100 BBL / 12 ton');
  assert.equal(quantityColumnHeader('mixed'), 'Qty (mixed — not summed)');
});
