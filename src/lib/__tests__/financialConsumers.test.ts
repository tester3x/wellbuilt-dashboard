/**
 * Consumer-level financial tests: billing, payroll, exports, formatting.
 * Exercises the firebase-free mapping used by billing.ts, payroll.ts, and billingExport.ts.
 * Run via npm test (node --test --experimental-strip-types).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  billingLineFromInvoiceRecord,
  exportMoneyCell,
  formatPayrollMoneyCell,
  generateInvoiceCSV,
  jsonLineExport,
  pdfLinePresentment,
  payrollRowFromInvoiceRecord,
  quickBooksAmountCells,
  type BillingLineItem,
  type MappingCompany,
} from '../financialInvoiceMapping.ts';
import {
  hoursDisplay,
  mixedQuantitySummary,
  moneyContribution,
  moneyDisplay,
  projectFinancialLine,
  resolveFinancialRate,
  selectConfiguredSplit,
} from '../financialCorrectnessCore.ts';
import type { CompanyRateSheets } from '../financialCorrectnessCore.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, '..', 'financialGoldenFixtures.v1.json'), 'utf8'));

function company(over: Partial<MappingCompany> = {}): MappingCompany {
  return {
    name: 'Acme Hauling',
    payConfig: { defaultSplit: 0.25 },
    rateSheets: fixtures.rateSheet as CompanyRateSheets,
    ...over,
  };
}

function closedInvoice(over: Record<string, unknown> = {}) {
  return {
    status: 'closed',
    operator: 'Acme',
    commodityType: 'Production Water',
    totalBBL: 100,
    totalHours: 2,
    date: '09/17/2026',
    invoiceNumber: 'INV-1',
    driver: 'Driver A',
    wellName: 'Well One',
    hauledTo: 'SWD',
    ...over,
  };
}

function groupFrom(item: BillingLineItem) {
  return {
    operator: 'Acme',
    wellName: item.wellName,
    dateRange: 'Sep 17',
    lineItems: [item],
    subtotal: moneyContribution(item.baseAmount, item.amountUnresolved),
    totalFuelSurcharge: moneyContribution(item.fuelSurcharge, item.amountUnresolved),
    totalDetentionPay: moneyContribution(item.detentionPay, item.amountUnresolved),
    grandTotal: moneyContribution(item.total, item.amountUnresolved),
    totalBBLs: item.qtyUnit === 'bbl' && item.qtyValue != null ? item.qtyValue : 0,
    totalHours: item.hours,
    loads: 1,
  };
}

test('billing/payroll consumers: reordered sheets match; duplicates unresolved', () => {
  const exact = billingLineFromInvoiceRecord(closedInvoice(), 'id1', company());
  const reordered = billingLineFromInvoiceRecord(closedInvoice(), 'id1', company({
    rateSheets: fixtures.rateSheetReordered as CompanyRateSheets,
  }));
  assert.ok(exact && reordered);
  assert.equal(exact.baseAmount, 240);
  assert.equal(reordered.baseAmount, 240);
  assert.equal(exact.amountUnresolved, null);
  const dup = billingLineFromInvoiceRecord(closedInvoice(), 'id1', company({
    rateSheets: fixtures.rateSheetDuplicate as CompanyRateSheets,
  }));
  assert.ok(dup);
  assert.ok(dup.amountUnresolved);
  assert.match(formatPayrollMoneyCell(dup.baseAmount, dup.amountUnresolved), /^UNRESOLVED \(/);
  const payrollDup = payrollRowFromInvoiceRecord(closedInvoice(), 'id1', company({
    rateSheets: fixtures.rateSheetDuplicate as CompanyRateSheets,
  }));
  assert.ok(payrollDup?.amountUnresolved);
  assert.match(formatPayrollMoneyCell(payrollDup.amountBilled, payrollDup.amountUnresolved), /^UNRESOLVED \(/);
});

test('duplicate alias matches are unresolved', () => {
  const aliasDup = {
    Acme: [
      { jobType: 'Production Water', method: 'per_bbl', rate: 2.4 },
      { jobType: 'Production %', method: 'per_bbl', rate: 9.9 },
    ],
  } as CompanyRateSheets;
  const viaAlias = billingLineFromInvoiceRecord(closedInvoice({ commodityType: 'PRODUCTION WATER' }), 'id1', company({
    rateSheets: aliasDup,
  }));
  assert.ok(viaAlias?.amountUnresolved);
  assert.match(String(viaAlias.amountUnresolved), /ambiguous/);
  assert.match(formatPayrollMoneyCell(viaAlias.baseAmount, viaAlias.amountUnresolved), /^UNRESOLVED \(/);
});

test('unknown, transferred, and malformed statuses never enter billing or payroll money', () => {
  for (const status of ['open', 'in_progress', 'transferred', 'transfer_pending', 'mystery', null]) {
    assert.equal(billingLineFromInvoiceRecord(closedInvoice({ status }), 'id1', company()), null);
    assert.equal(payrollRowFromInvoiceRecord(closedInvoice({ status }), 'id1', company()), null);
  }
  const paid = billingLineFromInvoiceRecord(closedInvoice({ status: 'paid' }), 'id1', company());
  assert.ok(paid);
  assert.equal(paid.baseAmount, 240);
});

test('explicit zero rate and split stay distinct from missing/malformed', () => {
  const zeroRate = billingLineFromInvoiceRecord(closedInvoice(), 'id1', company({
    rateSheets: fixtures.rateSheetZero as CompanyRateSheets,
  }));
  assert.ok(zeroRate);
  assert.equal(zeroRate.baseAmount, 0);
  assert.equal(zeroRate.amountUnresolved, null);
  assert.equal(formatPayrollMoneyCell(zeroRate.baseAmount, zeroRate.amountUnresolved), '0');
  const zeroSplitCo = company({ payConfig: { employeeSplit: 0, defaultSplit: 0.25 } });
  const row = payrollRowFromInvoiceRecord(closedInvoice(), 'id1', zeroSplitCo);
  assert.ok(row);
  assert.equal(row.amountUnresolved, null);
  assert.equal(row.employeeTake, 0);
  const missingSplit = payrollRowFromInvoiceRecord(closedInvoice(), 'id1', company({
    payConfig: {},
  }));
  assert.ok(missingSplit?.amountUnresolved);
  assert.match(formatPayrollMoneyCell(missingSplit.employeeTake, missingSplit.amountUnresolved), /^UNRESOLVED \(/);
  const malformed = payrollRowFromInvoiceRecord(closedInvoice(), 'id1', company({
    payConfig: { employeeSplit: 'bad', defaultSplit: 0.25 },
  }));
  assert.ok(malformed?.amountUnresolved);
  assert.match(formatPayrollMoneyCell(malformed.employeeTake, malformed.amountUnresolved), /^UNRESOLVED \(/);
  assert.equal(selectConfiguredSplit({ employeeSplit: 0, defaultSplit: 0.25 }), 0);
  assert.equal(selectConfiguredSplit({ employeeSplit: 'bad', defaultSplit: 0.25 }), 'bad');
});

test('typed BBL, tons, zero qty, untyped qty, mixed units, ton vs per-bbl', () => {
  const bbl = billingLineFromInvoiceRecord(closedInvoice({ totalBBL: 40 }), 'id1', company());
  assert.equal(bbl?.qtyUnit, 'bbl');
  assert.equal(bbl?.qtyValue, 40);
  const tons = billingLineFromInvoiceRecord(closedInvoice({ totalBBL: undefined, tons: 22.5 }), 'id1', company());
  assert.ok(tons);
  assert.equal(tons.qtyUnit, 'ton');
  assert.match(String(tons.qtyDisplay), /ton/);
  assert.doesNotMatch(String(tons.qtyDisplay), /BBL/);
  assert.ok(tons.amountUnresolved);
  assert.match(moneyDisplay(tons.baseAmount || null, tons.amountUnresolved), /^UNRESOLVED \(/);
  const zeroQty = billingLineFromInvoiceRecord(closedInvoice({ totalBBL: 0 }), 'id1', company());
  assert.equal(zeroQty?.qtyValue, 0);
  assert.equal(zeroQty?.amountUnresolved, null);
  const untyped = billingLineFromInvoiceRecord(closedInvoice({ totalBBL: undefined, qty: 40 }), 'id1', company());
  assert.ok(untyped?.amountUnresolved);
  assert.match(String(untyped.qtyDisplay), /UNRESOLVED/);
  const mixed = billingLineFromInvoiceRecord(closedInvoice({ totalBBL: 100, tons: 12 }), 'id1', company());
  assert.ok(mixed?.amountUnresolved);
  assert.equal(mixedQuantitySummary(100, 12), '100 BBL / 12 ton');
});

test('allocated 5/5 keeps observed 10; legacy totalHours is labeled', () => {
  const hourly = billingLineFromInvoiceRecord(closedInvoice({
    commodityType: 'Service Work', observedHours: 10, allocatedHours: 5, allocationMethod: 'equal', totalHours: undefined,
  }), 'id1', company({
    rateSheets: { Acme: [{ jobType: 'Service Work', method: 'hourly', rate: 150 }] } as CompanyRateSheets,
  }));
  assert.ok(hourly);
  assert.match(hourly.hoursDisplay || '', /5 allocated/);
  assert.match(hourly.hoursDisplay || '', /10 observed/);
  const legacy = payrollRowFromInvoiceRecord(closedInvoice({ totalHours: 8 }), 'id1', company());
  assert.ok(legacy);
  assert.match(legacy.hoursDisplay || hoursDisplay({
    provenance: 'legacy_unknown', label: 'legacy/unknown provenance',
    observedHours: null, allocatedHours: null, financialHours: 8, allocationMethod: null, allocationVersion: null,
  }), /legacy/);
});

test('CSV, QuickBooks, JSON, and PDF emit UNRESOLVED instead of $0.00 for missing rates', () => {
  const item = billingLineFromInvoiceRecord(closedInvoice({ commodityType: 'Skim Oil' }), 'id1', company());
  assert.ok(item?.amountUnresolved);
  const grouped = [groupFrom(item)];
  const csv = generateInvoiceCSV(grouped, ['WB-1'], {});
  assert.match(csv, /UNRESOLVED \(/);
  assert.doesNotMatch(csv, /"0.00"/);
  const qb = quickBooksAmountCells(item);
  assert.match(qb.amount, /^UNRESOLVED \(/);
  assert.match(qb.rate, /^UNRESOLVED \(/);
  const json = JSON.stringify(jsonLineExport(item, {}));
  assert.match(json, /amountUnresolved/);
  assert.match(json, /UNRESOLVED \(/);
  const pdf = pdfLinePresentment(item, {});
  assert.match(pdf.amount, /^UNRESOLVED \(/);
  assert.doesNotMatch(pdf.amount, /\$0\.00/);
  const payroll = payrollRowFromInvoiceRecord(closedInvoice({ commodityType: 'Skim Oil' }), 'id1', company());
  assert.match(formatPayrollMoneyCell(payroll?.amountBilled, payroll?.amountUnresolved), /^UNRESOLVED \(/);
  assert.match(exportMoneyCell(item.total, item.amountUnresolved), /^UNRESOLVED \(/);
});

test('unresolved numeric placeholders cannot be summed without the unresolved flag', () => {
  const resolved = billingLineFromInvoiceRecord(closedInvoice(), 'id1', company());
  const unresolved = billingLineFromInvoiceRecord(closedInvoice({ commodityType: 'Skim Oil' }), 'id2', company());
  assert.ok(resolved && unresolved);
  const naive = [resolved, unresolved].reduce((s, r) => s + (r.baseAmount ?? 0), 0);
  const guarded = [resolved, unresolved].reduce((s, r) => s + moneyContribution(r.baseAmount, r.amountUnresolved), 0);
  assert.equal(guarded, 240);
  assert.equal(naive, 240);
  assert.equal(moneyContribution(0, 'rate:no_match'), 0);
  assert.equal(moneyContribution(0, null), 0);
  assert.notEqual(formatPayrollMoneyCell(0, 'rate:no_match'), '0');
});

test('cross-repo identical facts: Dashboard line matches golden projection', () => {
  const facts = {
    status: 'closed',
    operator: 'Acme',
    jobType: 'Production Water',
    quantity: { totalBBL: 100 },
    time: { totalHours: 2 },
    rateSheets: fixtures.rateSheet,
    defaultSplit: selectConfiguredSplit({ defaultSplit: 0.25 }),
  };
  const core = projectFinancialLine(facts);
  const bill = billingLineFromInvoiceRecord(closedInvoice(), 'id1', company());
  const pay = payrollRowFromInvoiceRecord(closedInvoice(), 'id1', company());
  assert.equal(core.amountBilled, 240);
  assert.equal(bill?.baseAmount, 240);
  assert.equal(pay?.amountBilled, 240);
  assert.equal(core.employeeTake, 60);
  assert.equal(pay?.employeeTake, 60);
  const reordered = resolveFinancialRate(fixtures.rateSheetReordered, 'Acme', 'Production Water');
  assert.equal(reordered.state, 'resolved');
});
