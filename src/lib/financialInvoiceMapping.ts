/**
 * Firebase-free invoice → billing/payroll/export presentment.
 * Production billing.ts / payroll.ts / billingExport.ts call these helpers
 * so consumer tests exercise the same functions the UI and exports use.
 */
import {
  hoursDisplay,
  moneyDisplay,
  projectFinancialLine,
  quantityDisplay,
  selectConfiguredSplit,
  type CompanyRateSheets,
  type FinancialRateEntry,
} from './financialCorrectnessCore.ts';

export interface MappingCompany {
  name?: string;
  payConfig?: {
    employeeSplit?: unknown;
    defaultSplit?: unknown;
  };
  rateSheets?: CompanyRateSheets;
}

export interface BillingLineItem {
  invoiceId: string;
  invoiceNumber: string;
  date: string;
  wellName: string;
  hauledTo: string;
  driver: string;
  jobType: string;
  bbls: number;
  hours: number;
  fuelMinutes: number;
  driveDistanceMiles: number;
  rateMethod: 'per_bbl' | 'hourly';
  rate: number;
  baseAmount: number;
  fuelSurcharge: number;
  detentionPay: number;
  swdWaitMinutes: number;
  total: number;
  qtyUnit?: 'bbl' | 'ton' | null;
  qtyValue?: number | null;
  qtyDisplay?: string;
  qtyState?: string;
  observedHours?: number | null;
  allocatedHours?: number | null;
  hoursProvenance?: string;
  hoursDisplay?: string;
  amountUnresolved?: string | null;
}

export interface DriverTimesheetRow {
  id: string;
  date: string;
  invoiceNumber: string;
  operator: string;
  wellName: string;
  jobType: string;
  bbls: number;
  hours: number;
  rate: number;
  amountBilled: number;
  detentionPay: number;
  swdWaitMinutes: number;
  employeeTake: number;
  tickets: string[];
  qtyUnit?: 'bbl' | 'ton' | null;
  qtyValue?: number | null;
  qtyState?: string;
  qtyDisplay?: string;
  observedHours?: number | null;
  allocatedHours?: number | null;
  hoursProvenance?: string;
  hoursDisplay?: string;
  amountUnresolved?: string | null;
}

export interface ExportGroup {
  operator: string;
  wellName?: string;
  dateRange: string;
  lineItems: BillingLineItem[];
  subtotal: number;
  totalFuelSurcharge: number;
  totalDetentionPay: number;
  grandTotal: number;
  totalBBLs: number;
  totalHours: number;
  loads: number;
}

export interface MappedInvoice {
  item: BillingLineItem | null;
  rateEntry: FinancialRateEntry | null;
}

export function formatPayrollMoneyCell(amount: number | null | undefined, unresolved: string | null | undefined): string {
  return moneyDisplay(amount ?? null, unresolved ?? null);
}

export function exportMoneyCell(amount: number, unresolved: string | null | undefined): string {
  return unresolved ? `UNRESOLVED (${unresolved})` : amount.toFixed(2);
}

export function pdfAmountCell(amount: number, unresolved: string | null | undefined): string {
  if (unresolved) return `UNRESOLVED (${unresolved})`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function assembleInvoiceFacts(
  d: Record<string, unknown>,
  company: MappingCompany | null | undefined,
) {
  const operator = String(d.operator || '');
  const jobType = String(d.commodityType || d.jobType || '');
  const observedHours = typeof d.observedHours === 'number'
    ? d.observedHours
    : (typeof d.actualDriveMinutes === 'number' ? d.actualDriveMinutes / 60 : undefined);
  return {
    status: d.status,
    operator,
    jobType,
    commodityType: typeof d.commodityType === 'string' ? d.commodityType : undefined,
    quantity: {
      totalBBL: typeof d.totalBBL === 'number' ? d.totalBBL : undefined,
      bbls: typeof d.bbls === 'number' ? d.bbls : (d.bbls != null ? parseFloat(String(d.bbls)) : undefined),
      qty: (typeof d.qty === 'number' || typeof d.qty === 'string') ? d.qty : undefined,
      qtyUnit: (d.qtyUnit || d.unit) as string | undefined,
      unit: d.unit as string | undefined,
      tons: typeof d.tons === 'number' ? d.tons : undefined,
      netWeight: typeof d.netWeight === 'number' ? d.netWeight : undefined,
    },
    time: {
      totalHours: typeof d.totalHours === 'number' ? d.totalHours : undefined,
      allocatedHours: typeof d.allocatedHours === 'number' ? d.allocatedHours : undefined,
      observedHours,
      allocationMethod: (d.splitTimeAllocation || d.allocationMethod || null) as string | null,
      allocationVersion: (d.allocationVersion || null) as string | null,
    },
    rateSheets: company?.rateSheets,
    defaultSplit: selectConfiguredSplit(company?.payConfig),
  };
}

export function mapInvoiceToBilling(
  d: Record<string, unknown>,
  invoiceId: string,
  company: MappingCompany | null | undefined,
): MappedInvoice {
  const facts = assembleInvoiceFacts(d, company);
  if (!facts.operator) return { item: null, rateEntry: null };
  const line = projectFinancialLine(facts);
  if (!line.eligible.eligible) return { item: null, rateEntry: null };
  const unresolved = line.amountBilled === null ? line.amountReason : null;
  let rate = 0;
  let rateMethod: 'per_bbl' | 'hourly' = 'per_bbl';
  let baseAmount = 0;
  let rateEntry: FinancialRateEntry | null = null;
  if (line.rate.state === 'resolved' || line.rate.state === 'explicit_zero') {
    rateMethod = line.rate.entry.method;
    rate = line.rate.entry.rate;
    rateEntry = line.rate.entry;
    if (line.amountBilled !== null) baseAmount = line.amountBilled;
  }
  const item: BillingLineItem = {
    invoiceId,
    invoiceNumber: String(d.invoiceNumber || (Array.isArray(d.tickets) && d.tickets[0]) || ''),
    date: String(d.date || ''),
    wellName: String(d.wellName || ''),
    hauledTo: String(d.hauledTo || ''),
    driver: String(d.driver || ''),
    jobType: facts.jobType,
    bbls: line.qtyForBblColumn ?? 0,
    hours: line.hoursForMoney ?? 0,
    fuelMinutes: Number(d.fuelMinutes || 0),
    driveDistanceMiles: Number(d.driveDistanceMiles || 0),
    rateMethod,
    rate,
    baseAmount,
    fuelSurcharge: 0,
    detentionPay: 0,
    swdWaitMinutes: Number(d.swdWaitMinutes || 0),
    total: unresolved ? 0 : baseAmount,
    qtyUnit: line.quantity.state === 'unresolved' ? null : line.quantity.unit,
    qtyValue: line.quantity.state === 'unresolved' ? null : line.quantity.value,
    qtyDisplay: quantityDisplay(line.quantity),
    qtyState: line.quantity.state,
    observedHours: line.time.observedHours,
    allocatedHours: line.time.allocatedHours,
    hoursProvenance: line.time.label,
    hoursDisplay: hoursDisplay(line.time),
    amountUnresolved: unresolved,
  };
  return { item, rateEntry };
}

export function billingLineFromInvoiceRecord(
  d: Record<string, unknown>,
  invoiceId: string,
  company: MappingCompany | null | undefined,
): BillingLineItem | null {
  return mapInvoiceToBilling(d, invoiceId, company).item;
}

export function payrollRowFromInvoiceRecord(
  d: Record<string, unknown>,
  invoiceId: string,
  company: MappingCompany | null | undefined,
): DriverTimesheetRow | null {
  const mapped = mapInvoiceToBilling(d, invoiceId, company);
  if (!mapped.item) return null;
  const item = mapped.item;
  const facts = assembleInvoiceFacts(d, company);
  const line = projectFinancialLine(facts);
  const unresolved = line.employeeTake === null
    ? (line.amountReason || item.amountUnresolved)
    : item.amountUnresolved;
  return {
    id: invoiceId,
    date: item.date,
    invoiceNumber: item.invoiceNumber,
    operator: facts.operator,
    wellName: item.wellName,
    jobType: item.jobType,
    bbls: item.bbls,
    qtyValue: item.qtyValue ?? null,
    hours: item.hours,
    rate: item.rate,
    amountBilled: item.baseAmount,
    detentionPay: item.detentionPay,
    swdWaitMinutes: item.swdWaitMinutes,
    employeeTake: line.employeeTake ?? 0,
    tickets: Array.isArray(d.tickets) ? d.tickets as string[] : [],
    qtyUnit: item.qtyUnit,
    qtyState: item.qtyState,
    qtyDisplay: item.qtyDisplay,
    observedHours: item.observedHours,
    allocatedHours: item.allocatedHours,
    hoursProvenance: item.hoursProvenance,
    hoursDisplay: item.hoursDisplay,
    amountUnresolved: unresolved,
  };
}

export function pdfLinePresentment(
  item: BillingLineItem,
  legalNameMap: Record<string, string> = {},
  includeWell = false,
): Record<string, string> {
  const row: Record<string, string> = {
    date: item.date,
    invoiceNumber: item.invoiceNumber,
    hauledTo: item.hauledTo || '--',
    driver: legalNameMap[item.driver] || item.driver,
    qty: item.amountUnresolved || item.qtyState === 'unresolved'
      ? (item.qtyDisplay || 'UNRESOLVED')
      : (item.qtyValue != null ? String(item.qtyValue) : '--'),
    unit: item.qtyUnit === 'ton' ? 'ton' : item.qtyUnit === 'bbl' ? 'BBL' : '--',
    hours: item.hoursDisplay || String(item.hours || '--'),
    hoursSource: item.hoursProvenance || 'legacy/unknown',
    amount: pdfAmountCell(item.baseAmount, item.amountUnresolved),
  };
  if (includeWell) row.wellName = item.wellName;
  return row;
}

export function csvInvoiceLine(
  item: BillingLineItem,
  invoiceNumber: string,
  operator: string,
  legalNameMap: Record<string, string> = {},
): string[] {
  return [
    invoiceNumber,
    item.date,
    operator,
    item.wellName,
    item.hauledTo || '',
    legalNameMap[item.driver] || item.driver,
    item.jobType || '',
    item.qtyValue != null ? String(item.qtyValue) : '',
    item.qtyUnit === 'ton' ? 'ton' : item.qtyUnit === 'bbl' ? 'BBL' : '',
    String(item.hours || 0),
    item.hoursProvenance || 'legacy/unknown',
    item.amountUnresolved ? '' : String(item.rate || 0),
    item.rateMethod || '',
    exportMoneyCell(item.baseAmount, item.amountUnresolved),
    exportMoneyCell(item.fuelSurcharge, item.amountUnresolved),
    exportMoneyCell(item.detentionPay, item.amountUnresolved),
    exportMoneyCell(item.total, item.amountUnresolved),
    item.amountUnresolved || item.qtyDisplay || '',
  ];
}

export function generateInvoiceCSV(
  groups: ExportGroup[],
  invoiceNumbers: string[],
  legalNameMap: Record<string, string> = {},
): string {
  const headers = [
    'Billing Invoice #', 'Date', 'Operator', 'Well', 'Drop-off', 'Driver',
    'Job Type', 'Qty', 'Unit', 'Hours', 'Hours source', 'Rate', 'Rate Method', 'Base Amount',
    'Fuel Surcharge', 'Detention', 'Total', 'Qty/Rate state',
  ];
  const rows: string[][] = [];
  groups.forEach((group, gi) => {
    group.lineItems.forEach(item => {
      rows.push(csvInvoiceLine(item, invoiceNumbers[gi], group.operator, legalNameMap));
    });
  });
  return [
    headers.join(','),
    ...rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');
}

export function quickBooksAmountCells(item: BillingLineItem): { rate: string; amount: string } {
  const cell = exportMoneyCell(item.baseAmount, item.amountUnresolved);
  return { rate: item.amountUnresolved ? cell : item.baseAmount.toFixed(2), amount: cell };
}

export function jsonLineExport(item: BillingLineItem, legalNameMap: Record<string, string> = {}) {
  return {
    date: item.date,
    wbInvoiceNumber: item.invoiceNumber,
    wellName: item.wellName,
    dropOff: item.hauledTo || undefined,
    driver: legalNameMap[item.driver] || item.driver,
    jobType: item.jobType || undefined,
    qty: item.qtyValue,
    qtyUnit: item.qtyUnit,
    qtyDisplay: item.qtyDisplay,
    hours: item.hours,
    observedHours: item.observedHours,
    allocatedHours: item.allocatedHours,
    hoursProvenance: item.hoursProvenance,
    amountUnresolved: item.amountUnresolved,
    rateMethod: item.rateMethod,
    rate: item.rate,
    baseAmount: item.baseAmount,
    fuelSurcharge: item.fuelSurcharge,
    detentionPay: item.detentionPay,
    swdWaitMinutes: item.swdWaitMinutes || undefined,
    total: item.total,
    baseAmountExport: exportMoneyCell(item.baseAmount, item.amountUnresolved),
    totalExport: exportMoneyCell(item.total, item.amountUnresolved),
  };
}
