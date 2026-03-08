import { getFirestoreDb } from './firebase';
import { collection, doc, getDoc, getDocs, setDoc, query, where, orderBy, limit, Timestamp } from 'firebase/firestore';
import { type CompanyConfig, type OperatorBillingConfig } from './companySettings';
import { type OperatorBillingSummary, type BillingLineItem, calculateDueDate, getFuelSurchargeRate, getFuelSurchargeLabel } from './billing';
import { formatCurrency, type PayPeriod } from './payroll';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// ─── Export Formats ─────────────────────────────────────────────────────────

export type ExportFormat = 'pdf' | 'csv' | 'quickbooks' | 'json';

export const EXPORT_FORMATS: { value: ExportFormat; label: string; description: string }[] = [
  { value: 'pdf', label: 'PDF Invoices', description: 'Professional multi-page invoice document' },
  { value: 'csv', label: 'CSV (Generic)', description: 'Universal spreadsheet format — works everywhere' },
  { value: 'quickbooks', label: 'QuickBooks CSV', description: 'Import-ready for QuickBooks Desktop & Online' },
  { value: 'json', label: 'JSON (API)', description: 'Structured data for system integrations' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

export type InvoiceGrouping = 'well_day' | 'well_period' | 'operator_summary';

export interface GroupedInvoice {
  groupKey: string;
  operator: string;
  wellName?: string;
  date?: string;
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

export interface BillingExportRecord {
  id: string;
  companyId: string;
  operator: string | null;
  grouping: InvoiceGrouping;
  periodStart: any;
  periodEnd: any;
  invoiceNumberStart: string;
  invoiceNumberEnd: string;
  invoiceCount: number;
  grandTotal: number;
  format: ExportFormat;
  generatedAt: any;
}

// ─── Test Well Filter ────────────────────────────────────────────────────────

/**
 * Load all real well names (NDIC + MBOGC) as a Set for fast lookup.
 * Used to filter out test wells from billing exports.
 */
export async function loadRealWellNames(): Promise<Set<string>> {
  const db = getFirestoreDb();
  const snap = await getDocs(collection(db, 'wells'));
  const names = new Set<string>();
  snap.forEach(d => {
    const data = d.data();
    if (data.well_name) names.add(data.well_name.toLowerCase().trim());
    if (data.search_name) names.add(data.search_name.toLowerCase().trim());
  });
  return names;
}

/**
 * Filter line items to only include real wells (matched against NDIC/MBOGC database).
 * Test data with made-up well names gets excluded automatically.
 */
export function filterTestWells(
  summaries: OperatorBillingSummary[],
  realWellNames: Set<string>,
): OperatorBillingSummary[] {
  return summaries.map(summary => {
    const filtered = summary.lineItems.filter(item => {
      const norm = item.wellName.toLowerCase().trim();
      return realWellNames.has(norm);
    });
    if (filtered.length === 0) return null;
    const subtotal = filtered.reduce((s, i) => s + i.baseAmount, 0);
    const totalFuelSurcharge = filtered.reduce((s, i) => s + i.fuelSurcharge, 0);
    const totalDetentionPay = filtered.reduce((s, i) => s + i.detentionPay, 0);
    return {
      ...summary,
      lineItems: filtered,
      loads: filtered.length,
      totalBBLs: filtered.reduce((s, i) => s + i.bbls, 0),
      totalHours: Math.round(filtered.reduce((s, i) => s + i.hours, 0) * 10) / 10,
      subtotal: Math.round(subtotal * 100) / 100,
      totalFuelSurcharge: Math.round(totalFuelSurcharge * 100) / 100,
      totalDetentionPay: Math.round(totalDetentionPay * 100) / 100,
      grandTotal: Math.round((subtotal + totalFuelSurcharge + totalDetentionPay) * 100) / 100,
    };
  }).filter(Boolean) as OperatorBillingSummary[];
}

// ─── Grouping Logic ──────────────────────────────────────────────────────────

function buildGroup(
  operator: string,
  items: BillingLineItem[],
  wellName?: string,
  date?: string,
  dateRange?: string,
): GroupedInvoice {
  const subtotal = items.reduce((s, i) => s + i.baseAmount, 0);
  const totalFuelSurcharge = items.reduce((s, i) => s + i.fuelSurcharge, 0);
  const totalDetentionPay = items.reduce((s, i) => s + i.detentionPay, 0);
  return {
    groupKey: `${operator}|||${wellName || 'ALL'}|||${date || 'PERIOD'}`,
    operator,
    wellName,
    date,
    dateRange: dateRange || date || '',
    lineItems: items,
    subtotal: Math.round(subtotal * 100) / 100,
    totalFuelSurcharge: Math.round(totalFuelSurcharge * 100) / 100,
    totalDetentionPay: Math.round(totalDetentionPay * 100) / 100,
    grandTotal: Math.round((subtotal + totalFuelSurcharge + totalDetentionPay) * 100) / 100,
    totalBBLs: items.reduce((s, i) => s + i.bbls, 0),
    totalHours: Math.round(items.reduce((s, i) => s + i.hours, 0) * 10) / 10,
    loads: items.length,
  };
}

export function groupInvoiceData(
  summaries: OperatorBillingSummary[],
  grouping: InvoiceGrouping,
  operatorFilter?: string,
): GroupedInvoice[] {
  const filtered = operatorFilter
    ? summaries.filter(s => s.operator === operatorFilter)
    : summaries;

  const groups: GroupedInvoice[] = [];

  for (const summary of filtered) {
    switch (grouping) {
      case 'well_day': {
        // Group by normalized well name (case-insensitive) + date
        const byWellDay = new Map<string, { displayName: string; items: BillingLineItem[] }>();
        for (const item of summary.lineItems) {
          const normKey = `${item.wellName.toLowerCase().trim()}|||${item.date}`;
          if (!byWellDay.has(normKey)) byWellDay.set(normKey, { displayName: item.wellName, items: [] });
          byWellDay.get(normKey)!.items.push(item);
        }
        byWellDay.forEach(({ displayName, items }, key) => {
          const d = key.split('|||')[1];
          groups.push(buildGroup(summary.operator, items, displayName, d, d));
        });
        break;
      }
      case 'well_period': {
        // Group by normalized well name (case-insensitive)
        const byWell = new Map<string, { displayName: string; items: BillingLineItem[] }>();
        for (const item of summary.lineItems) {
          const normKey = item.wellName.toLowerCase().trim();
          if (!byWell.has(normKey)) byWell.set(normKey, { displayName: item.wellName, items: [] });
          byWell.get(normKey)!.items.push(item);
        }
        byWell.forEach(({ displayName, items }) => {
          const dates = items.map(i => i.date).sort();
          groups.push(buildGroup(summary.operator, items, displayName, undefined,
            dates.length === 1 ? dates[0] : `${dates[0]} - ${dates[dates.length - 1]}`));
        });
        break;
      }
      case 'operator_summary': {
        const dates = summary.lineItems.map(i => i.date).sort();
        const range = dates.length === 1 ? dates[0] : `${dates[0]} - ${dates[dates.length - 1]}`;
        groups.push(buildGroup(summary.operator, summary.lineItems, undefined, undefined, range));
        break;
      }
    }
  }

  groups.sort((a, b) => {
    const opCmp = a.operator.localeCompare(b.operator);
    if (opCmp !== 0) return opCmp;
    const wellCmp = (a.wellName || '').localeCompare(b.wellName || '');
    if (wellCmp !== 0) return wellCmp;
    return (a.date || '').localeCompare(b.date || '');
  });

  return groups;
}

// ─── Invoice Numbering ───────────────────────────────────────────────────────

export async function getNextInvoiceNumbers(
  companyId: string,
  count: number,
  prefix: string,
): Promise<string[]> {
  const db = getFirestoreDb();
  const year = new Date().getFullYear();
  const counterRef = doc(db, 'billing_invoice_counters', companyId);
  const counterSnap = await getDoc(counterRef);

  let nextNum = 1;
  if (counterSnap.exists()) {
    const data = counterSnap.data();
    if (data.year === year) {
      nextNum = (data.counter || 0) + 1;
    }
  }

  const numbers: string[] = [];
  for (let i = 0; i < count; i++) {
    numbers.push(`${prefix}-${year}-${String(nextNum + i).padStart(4, '0')}`);
  }

  await setDoc(counterRef, { year, counter: nextNum + count - 1 });
  return numbers;
}

// ─── Logo Fetching ───────────────────────────────────────────────────────────

export async function fetchLogoAsBase64(logoUrl: string): Promise<string | null> {
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// ─── PDF Generation ──────────────────────────────────────────────────────────

export async function generateInvoicePDF(
  groups: GroupedInvoice[],
  invoiceNumbers: string[],
  company: CompanyConfig,
  billingConfigs: Record<string, OperatorBillingConfig> | undefined,
  dieselPrice: number | undefined,
  period: PayPeriod,
  legalNameMap: Record<string, string>,
): Promise<jsPDF> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  // Fetch logo once
  let logoData: string | null = null;
  if (company.logoUrl) {
    logoData = await fetchLogoAsBase64(company.logoUrl);
  }

  for (let i = 0; i < groups.length; i++) {
    if (i > 0) pdf.addPage();
    renderInvoicePage(
      pdf, groups[i], invoiceNumbers[i], company,
      billingConfigs?.[groups[i].operator], dieselPrice,
      period, legalNameMap, logoData,
    );
  }

  return pdf;
}

function renderInvoicePage(
  pdf: jsPDF,
  group: GroupedInvoice,
  invoiceNumber: string,
  company: CompanyConfig,
  billingConfig: OperatorBillingConfig | undefined,
  dieselPrice: number | undefined,
  period: PayPeriod,
  legalNameMap: Record<string, string>,
  logoData: string | null,
) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 40;
  const rightEdge = pageWidth - margin;
  let y = margin;

  // ── Header: Logo/Company + INVOICE ──
  if (logoData) {
    try {
      pdf.addImage(logoData, 'PNG', margin, y, 60, 40);
    } catch {
      // Logo failed — fall through to text
    }
  }

  pdf.setFontSize(24);
  pdf.setFont('helvetica', 'bold');
  pdf.text('INVOICE', rightEdge, y + 18, { align: 'right' });

  // Company info below logo area
  y += 50;
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text(company.name, margin, y);
  pdf.setFont('helvetica', 'normal');
  const companyAddress = buildCompanyAddress(company);
  if (companyAddress) {
    y += 14;
    pdf.text(companyAddress, margin, y);
  }
  if (company.phone) {
    y += 14;
    pdf.text(company.phone, margin, y);
  }

  // Invoice details (right side)
  const detailsY = 90;
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');

  const terms = billingConfig?.paymentTerms || 'net_30';
  const termsLabel = terms.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  const dueDate = calculateDueDate(period.end, terms);
  const today = new Date();

  const details = [
    ['Invoice #:', invoiceNumber],
    ['Date:', formatDate(today)],
    ['Terms:', termsLabel],
    ['Due:', formatDate(dueDate)],
  ];

  details.forEach(([label, value], idx) => {
    pdf.setFont('helvetica', 'bold');
    pdf.text(label, rightEdge - 120, detailsY + idx * 14);
    pdf.setFont('helvetica', 'normal');
    pdf.text(value, rightEdge, detailsY + idx * 14, { align: 'right' });
  });

  // ── Horizontal rule ──
  y += 20;
  pdf.setDrawColor(180);
  pdf.setLineWidth(0.5);
  pdf.line(margin, y, rightEdge, y);
  y += 20;

  // ── Bill To ──
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'bold');
  pdf.text('BILL TO:', margin, y);
  y += 14;
  pdf.setFontSize(11);
  pdf.text(group.operator, margin, y);
  y += 20;

  // ── Well / Period info ──
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  if (group.wellName) {
    pdf.setFont('helvetica', 'bold');
    pdf.text('Well:', margin, y);
    pdf.setFont('helvetica', 'normal');
    pdf.text(group.wellName, margin + 35, y);
    y += 14;
  }
  pdf.setFont('helvetica', 'bold');
  pdf.text('Period:', margin, y);
  pdf.setFont('helvetica', 'normal');
  pdf.text(group.dateRange, margin + 42, y);
  y += 20;

  // ── Line Items Table ──
  const isOperatorSummary = !group.wellName;
  const columns: any[] = [
    { header: 'Date', dataKey: 'date' },
  ];
  if (isOperatorSummary) {
    columns.push({ header: 'Well', dataKey: 'wellName' });
  }
  columns.push(
    { header: 'WB Inv #', dataKey: 'invoiceNumber' },
    { header: 'Drop-off', dataKey: 'hauledTo' },
    { header: 'Driver', dataKey: 'driver' },
    { header: 'BBLs', dataKey: 'bbls' },
    { header: 'Hours', dataKey: 'hours' },
    { header: 'Amount', dataKey: 'amount' },
  );

  const rows = group.lineItems.map(item => {
    const row: any = {
      date: item.date,
      invoiceNumber: item.invoiceNumber,
      hauledTo: item.hauledTo || '--',
      driver: legalNameMap[item.driver] || item.driver,
      bbls: item.bbls || '--',
      hours: item.hours || '--',
      amount: formatCurrency(item.baseAmount),
    };
    if (isOperatorSummary) row.wellName = item.wellName;
    return row;
  });

  autoTable(pdf, {
    startY: y,
    columns,
    body: rows,
    theme: 'grid',
    headStyles: {
      fillColor: [60, 60, 60],
      textColor: [255, 255, 255],
      fontSize: 8,
      fontStyle: 'bold',
    },
    bodyStyles: { fontSize: 8, textColor: [30, 30, 30] },
    columnStyles: {
      bbls: { halign: 'right' },
      hours: { halign: 'right' },
      amount: { halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });

  // Get Y position after table
  y = (pdf as any).lastAutoTable?.finalY || y + 100;
  y += 15;

  // ── Totals block (right-aligned) ──
  const totalsX = rightEdge - 180;
  const valuesX = rightEdge;
  pdf.setFontSize(9);

  const totalLines: [string, string, boolean][] = [
    ['Subtotal:', formatCurrency(group.subtotal), false],
  ];
  if (group.totalFuelSurcharge > 0) {
    totalLines.push(['Fuel Surcharge:', formatCurrency(group.totalFuelSurcharge), false]);
  }
  if (group.totalDetentionPay > 0) {
    totalLines.push(['SWD Detention:', formatCurrency(group.totalDetentionPay), false]);
  }

  totalLines.forEach(([label, value, _bold], idx) => {
    pdf.setFont('helvetica', 'normal');
    pdf.text(label, totalsX, y + idx * 16);
    pdf.text(value, valuesX, y + idx * 16, { align: 'right' });
  });

  y += totalLines.length * 16 + 4;
  pdf.setDrawColor(100);
  pdf.setLineWidth(0.5);
  pdf.line(totalsX, y, rightEdge, y);
  y += 14;

  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text('TOTAL DUE:', totalsX, y);
  pdf.text(formatCurrency(group.grandTotal), valuesX, y, { align: 'right' });

  // ── FSC description ──
  if (group.totalFuelSurcharge > 0 && billingConfig) {
    y += 24;
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(120);
    const fscLabel = getFuelSurchargeLabel(billingConfig);
    const rateInfo = getFuelSurchargeRate(billingConfig, dieselPrice);
    let fscDesc = `FSC: ${fscLabel}`;
    if (rateInfo) fscDesc += ` @ ${formatCurrency(rateInfo.rate)}${rateInfo.unit}`;
    if (dieselPrice) fscDesc += ` (DOE diesel: $${dieselPrice.toFixed(3)}/gal)`;
    pdf.text(fscDesc, margin, y);
    pdf.setTextColor(0);
  }

  // ── Footer ──
  const footerY = pdf.internal.pageSize.getHeight() - 40;
  pdf.setDrawColor(200);
  pdf.setLineWidth(0.3);
  pdf.line(margin, footerY - 10, rightEdge, footerY - 10);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(140);
  pdf.text('Thank you for your business.', margin, footerY);
  pdf.text('Generated by WellBuilt Suite - wellbuiltsuite.com', rightEdge, footerY, { align: 'right' });
  pdf.setTextColor(0);
}

// ─── CSV Generation ──────────────────────────────────────────────────────────

export function generateInvoiceCSV(
  groups: GroupedInvoice[],
  invoiceNumbers: string[],
  legalNameMap: Record<string, string>,
): string {
  const headers = [
    'Billing Invoice #', 'Date', 'Operator', 'Well', 'Drop-off', 'Driver',
    'Job Type', 'BBLs', 'Hours', 'Rate', 'Rate Method', 'Base Amount',
    'Fuel Surcharge', 'Detention', 'Total',
  ];

  const rows: string[][] = [];
  groups.forEach((group, gi) => {
    group.lineItems.forEach(item => {
      rows.push([
        invoiceNumbers[gi],
        item.date,
        group.operator,
        item.wellName,
        item.hauledTo || '',
        legalNameMap[item.driver] || item.driver,
        item.jobType || '',
        String(item.bbls || 0),
        String(item.hours || 0),
        String(item.rate || 0),
        item.rateMethod || '',
        item.baseAmount.toFixed(2),
        item.fuelSurcharge.toFixed(2),
        item.detentionPay.toFixed(2),
        item.total.toFixed(2),
      ]);
    });
  });

  const csvContent = [
    headers.join(','),
    ...rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');

  return csvContent;
}

// ─── QuickBooks CSV Generation ───────────────────────────────────────────────

/**
 * Generate QuickBooks-compatible CSV for import into QB Desktop or Online.
 * Uses QB's standard invoice import column headers.
 */
export function generateQuickBooksCSV(
  groups: GroupedInvoice[],
  invoiceNumbers: string[],
  company: CompanyConfig,
  billingConfigs: Record<string, OperatorBillingConfig> | undefined,
  period: PayPeriod,
  legalNameMap: Record<string, string>,
): string {
  // QB Online invoice import headers
  const headers = [
    'InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Terms',
    'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount',
    'Memo',
  ];

  const rows: string[][] = [];
  const today = formatDate(new Date());

  groups.forEach((group, gi) => {
    const invNum = invoiceNumbers[gi];
    const terms = billingConfigs?.[group.operator]?.paymentTerms || 'net_30';
    const termsLabel = terms.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
    const dueDate = formatDate(calculateDueDate(period.end, terms));

    // Line items
    group.lineItems.forEach(item => {
      const driver = legalNameMap[item.driver] || item.driver;
      const desc = [
        item.wellName,
        item.hauledTo ? `-> ${item.hauledTo}` : '',
        `${item.bbls} BBLs`,
        driver,
        item.date,
      ].filter(Boolean).join(' | ');

      rows.push([
        invNum, group.operator, today, dueDate, termsLabel,
        desc, '1', item.baseAmount.toFixed(2), item.baseAmount.toFixed(2),
        `${item.wellName} - ${item.date}`,
      ]);
    });

    // FSC as separate line item
    if (group.totalFuelSurcharge > 0) {
      rows.push([
        invNum, group.operator, today, dueDate, termsLabel,
        'Fuel Surcharge', '1', group.totalFuelSurcharge.toFixed(2),
        group.totalFuelSurcharge.toFixed(2), '',
      ]);
    }

    // Detention as separate line item
    if (group.totalDetentionPay > 0) {
      rows.push([
        invNum, group.operator, today, dueDate, termsLabel,
        'SWD Detention Pay', '1', group.totalDetentionPay.toFixed(2),
        group.totalDetentionPay.toFixed(2), '',
      ]);
    }
  });

  return [
    headers.join(','),
    ...rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');
}

// ─── JSON Export ─────────────────────────────────────────────────────────────

/**
 * Generate structured JSON export for API/system integrations.
 * Clean, well-typed data ready for programmatic consumption.
 */
export function generateInvoiceJSON(
  groups: GroupedInvoice[],
  invoiceNumbers: string[],
  company: CompanyConfig,
  billingConfigs: Record<string, OperatorBillingConfig> | undefined,
  period: PayPeriod,
  legalNameMap: Record<string, string>,
): string {
  const today = new Date().toISOString();

  const invoices = groups.map((group, gi) => {
    const invNum = invoiceNumbers[gi];
    const terms = billingConfigs?.[group.operator]?.paymentTerms || 'net_30';
    const dueDate = calculateDueDate(period.end, terms).toISOString().slice(0, 10);

    return {
      invoiceNumber: invNum,
      invoiceDate: today.slice(0, 10),
      dueDate,
      paymentTerms: terms,
      vendor: {
        name: company.name,
        address: buildCompanyAddress(company) || undefined,
        phone: company.phone || undefined,
      },
      billTo: {
        name: group.operator,
      },
      well: group.wellName || undefined,
      period: group.dateRange,
      lineItems: group.lineItems.map(item => ({
        date: item.date,
        wbInvoiceNumber: item.invoiceNumber,
        wellName: item.wellName,
        dropOff: item.hauledTo || undefined,
        driver: legalNameMap[item.driver] || item.driver,
        jobType: item.jobType || undefined,
        bbls: item.bbls,
        hours: item.hours,
        rateMethod: item.rateMethod,
        rate: item.rate,
        baseAmount: item.baseAmount,
        fuelSurcharge: item.fuelSurcharge,
        detentionPay: item.detentionPay,
        swdWaitMinutes: item.swdWaitMinutes || undefined,
        total: item.total,
      })),
      subtotal: group.subtotal,
      fuelSurcharge: group.totalFuelSurcharge,
      detentionPay: group.totalDetentionPay,
      grandTotal: group.grandTotal,
      totalBBLs: group.totalBBLs,
      totalHours: group.totalHours,
      loads: group.loads,
    };
  });

  return JSON.stringify({
    exportDate: today,
    generatedBy: 'WellBuilt Suite',
    company: company.name,
    periodStart: period.start.toISOString().slice(0, 10),
    periodEnd: period.end.toISOString().slice(0, 10),
    invoiceCount: invoices.length,
    grandTotal: invoices.reduce((s, i) => s + i.grandTotal, 0),
    invoices,
  }, null, 2);
}

// ─── Download Helper ─────────────────────────────────────────────────────────

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Export Record CRUD ──────────────────────────────────────────────────────

export async function saveBillingExport(record: Omit<BillingExportRecord, 'id'>): Promise<string> {
  const db = getFirestoreDb();
  const id = `exp_${Date.now()}`;
  await setDoc(doc(db, 'billing_exports', id), { ...record, id });
  return id;
}

export async function fetchRecentExports(companyId: string): Promise<BillingExportRecord[]> {
  const db = getFirestoreDb();
  const q = query(
    collection(db, 'billing_exports'),
    where('companyId', '==', companyId),
    orderBy('generatedAt', 'desc'),
    limit(10),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as BillingExportRecord);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildCompanyAddress(company: CompanyConfig): string {
  const parts: string[] = [];
  if (company.address) parts.push(company.address);
  const cityStateZip = [company.city, company.state].filter(Boolean).join(', ');
  if (cityStateZip && company.zip) parts.push(`${cityStateZip} ${company.zip}`);
  else if (cityStateZip) parts.push(cityStateZip);
  return parts.join(', ');
}

function formatDate(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

export function getExportFilename(
  prefix: string,
  period: PayPeriod,
  operator: string | null,
  format: ExportFormat,
): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[period.start.getMonth()];
  const year = period.start.getFullYear();
  const opLabel = operator ? operator.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').substring(0, 30) : 'All';
  const ext = format === 'quickbooks' ? 'csv' : format;
  const suffix = format === 'quickbooks' ? '-QB' : '';
  return `${prefix}-Invoices-${month}-${year}-${opLabel}${suffix}.${ext}`;
}
