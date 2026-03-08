import { getFirestoreDb } from './firebase';
import { collection, doc, getDoc, getDocs, setDoc, query, where, orderBy, limit, Timestamp } from 'firebase/firestore';
import { type CompanyConfig, type OperatorBillingConfig } from './companySettings';
import { type OperatorBillingSummary, type BillingLineItem, calculateDueDate, getFuelSurchargeRate, getFuelSurchargeLabel } from './billing';
import { formatCurrency, type PayPeriod } from './payroll';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

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
  format: 'pdf' | 'csv';
  generatedAt: any;
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
        const byWellDay = new Map<string, BillingLineItem[]>();
        for (const item of summary.lineItems) {
          const key = `${item.wellName}|||${item.date}`;
          if (!byWellDay.has(key)) byWellDay.set(key, []);
          byWellDay.get(key)!.push(item);
        }
        byWellDay.forEach((items, key) => {
          const [wn, d] = key.split('|||');
          groups.push(buildGroup(summary.operator, items, wn, d, d));
        });
        break;
      }
      case 'well_period': {
        const byWell = new Map<string, BillingLineItem[]>();
        for (const item of summary.lineItems) {
          if (!byWell.has(item.wellName)) byWell.set(item.wellName, []);
          byWell.get(item.wellName)!.push(item);
        }
        byWell.forEach((items, wn) => {
          const dates = items.map(i => i.date).sort();
          groups.push(buildGroup(summary.operator, items, wn, undefined,
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
  pdf.text('Generated by WellBuilt Suite  •  wellbuiltsuite.com', rightEdge, footerY, { align: 'right' });
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
  ext: 'pdf' | 'csv',
): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[period.start.getMonth()];
  const year = period.start.getFullYear();
  const opLabel = operator ? operator.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').substring(0, 30) : 'All';
  return `${prefix}-Invoices-${month}-${year}-${opLabel}.${ext}`;
}
