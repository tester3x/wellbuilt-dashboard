import { getFirestoreDb } from './firebase';
import { collection, getDocs, query, where, orderBy, Timestamp, doc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PayPeriodType = 'this-week' | 'last-week' | 'biweekly' | 'this-month' | 'last-month' | 'custom';

export type TimesheetStatus = 'building' | 'pending' | 'sent' | 'approved' | 'disputed';

export interface PayPeriod {
  type: PayPeriodType;
  start: Date;
  end: Date;
  label: string;
}

export interface RateEntry {
  jobType: string;
  method: 'per_bbl' | 'hourly';
  rate: number;
}

export interface DriverTimesheetRow {
  id: string;
  date: string;
  invoiceNumber: string;
  operator: string;
  wellName: string;
  jobType: string;       // commodityType / product
  bbls: number;
  hours: number;
  rate: number;
  amountBilled: number;
  employeeTake: number;
  tickets: string[];
  flagged?: boolean;
  flagNote?: string;
}

export interface DriverTimesheetSummary {
  driverName: string;
  driverHash?: string;
  companyId?: string;
  companyName?: string;
  truckNumber: string;
  totalLoads: number;
  totalHours: number;
  totalBBLs: number;
  grossBilled: number;
  employeePay: number;
  deductions: number;
  netPay: number;
  status: TimesheetStatus;
  rows: DriverTimesheetRow[];
}

// ─── Pay Period Helpers ──────────────────────────────────────────────────────

function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Monday
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getSunday(monday: Date): Date {
  const sun = new Date(monday);
  sun.setDate(sun.getDate() + 6);
  sun.setHours(23, 59, 59, 999);
  return sun;
}

function formatPeriodDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function getPayPeriods(): PayPeriod[] {
  const now = new Date();

  const thisMonday = getMonday(now);
  const thisSunday = getSunday(thisMonday);

  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);
  const lastSunday = getSunday(lastMonday);

  const biweeklyStart = new Date(lastMonday);
  biweeklyStart.setDate(biweeklyStart.getDate() - 7);
  const biweeklyEnd = lastSunday;

  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  return [
    {
      type: 'this-week',
      start: thisMonday,
      end: thisSunday,
      label: `This Week (${formatPeriodDate(thisMonday)} – ${formatPeriodDate(thisSunday)})`,
    },
    {
      type: 'last-week',
      start: lastMonday,
      end: lastSunday,
      label: `Last Week (${formatPeriodDate(lastMonday)} – ${formatPeriodDate(lastSunday)})`,
    },
    {
      type: 'this-month',
      start: thisMonthStart,
      end: thisMonthEnd,
      label: `This Month (${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`,
    },
    {
      type: 'last-month',
      start: lastMonthStart,
      end: lastMonthEnd,
      label: `Last Month (${lastMonthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`,
    },
  ];
}

// ─── Rate Sheet Lookup ───────────────────────────────────────────────────────

export interface CompanyRateSheets {
  [operatorName: string]: RateEntry[];
}

export function lookupRate(
  rateSheets: CompanyRateSheets,
  operator: string,
  jobType: string
): RateEntry | null {
  const operatorRates = rateSheets[operator];
  if (!operatorRates) return null;
  return operatorRates.find(r => r.jobType === jobType) || null;
}

// ─── Fetch Payroll Data ──────────────────────────────────────────────────────

export async function fetchPayrollInvoices(
  period: PayPeriod,
  companyId?: string
): Promise<DriverTimesheetSummary[]> {
  const db = getFirestoreDb();

  // Query invoices within the pay period date range
  // Invoices have 'createdAt' as Firestore Timestamp and 'date' as string
  // Try querying by createdAt timestamp range
  const constraints = [
    where('createdAt', '>=', Timestamp.fromDate(period.start)),
    where('createdAt', '<=', Timestamp.fromDate(period.end)),
    orderBy('createdAt', 'asc'),
  ];

  // Company scoping would add: where('companyId', '==', companyId)
  // For now, fetch all (WB admin / dev mode)

  const q = query(collection(db, 'invoices'), ...constraints);
  const snapshot = await getDocs(q);

  // Group invoices by driver
  const driverMap = new Map<string, DriverTimesheetRow[]>();

  snapshot.docs.forEach(docSnap => {
    const d = docSnap.data();

    // Skip open/in-progress invoices — only count closed+
    const status = d.status || 'open';
    if (status === 'open') return;

    const driverName = d.driver || 'Unknown';
    const row: DriverTimesheetRow = {
      id: docSnap.id,
      date: d.date || '',
      invoiceNumber: d.invoiceNumber || '',
      operator: d.operator || '',
      wellName: d.wellName || '',
      jobType: d.commodityType || d.jobType || '',
      bbls: d.totalBBL || 0,
      hours: d.totalHours || 0,
      rate: 0,           // Populated from rate sheet
      amountBilled: 0,   // Calculated from rate
      employeeTake: 0,   // Calculated from split
      tickets: d.tickets || [],
    };

    if (!driverMap.has(driverName)) {
      driverMap.set(driverName, []);
    }
    driverMap.get(driverName)!.push(row);
  });

  // Build summaries per driver
  const summaries: DriverTimesheetSummary[] = [];

  driverMap.forEach((rows, driverName) => {
    // Sort rows by date
    rows.sort((a, b) => a.date.localeCompare(b.date));

    const totalLoads = rows.length;
    const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
    const totalBBLs = rows.reduce((sum, r) => sum + r.bbls, 0);
    const grossBilled = rows.reduce((sum, r) => sum + r.amountBilled, 0);
    const employeePay = rows.reduce((sum, r) => sum + r.employeeTake, 0);

    // Get truck number from first row (typically consistent per driver)
    const truckNumber = rows[0]?.invoiceNumber ? '' : '';

    summaries.push({
      driverName,
      truckNumber: '',  // TODO: pull from driver record or first invoice
      totalLoads,
      totalHours: Math.round(totalHours * 100) / 100,
      totalBBLs: Math.round(totalBBLs),
      grossBilled: Math.round(grossBilled * 100) / 100,
      employeePay: Math.round(employeePay * 100) / 100,
      deductions: 0,    // TODO: pull from deductions collection
      netPay: Math.round(employeePay * 100) / 100,
      status: 'building',
      rows,
    });
  });

  // Sort by driver name
  summaries.sort((a, b) => a.driverName.localeCompare(b.driverName));

  return summaries;
}

// ─── Apply Rates ─────────────────────────────────────────────────────────────

export function applyRatesToTimesheet(
  summary: DriverTimesheetSummary,
  rateSheets: CompanyRateSheets,
  employeeSplit: number  // e.g. 0.25 for 25%
): DriverTimesheetSummary {
  const updatedRows = summary.rows.map(row => {
    const rateEntry = lookupRate(rateSheets, row.operator, row.jobType);
    if (!rateEntry) return row;

    const rate = rateEntry.rate;
    const amountBilled = rateEntry.method === 'per_bbl'
      ? row.bbls * rate
      : row.hours * rate;
    const employeeTake = amountBilled * employeeSplit;

    return {
      ...row,
      rate,
      amountBilled: Math.round(amountBilled * 100) / 100,
      employeeTake: Math.round(employeeTake * 100) / 100,
    };
  });

  const grossBilled = updatedRows.reduce((sum, r) => sum + r.amountBilled, 0);
  const employeePay = updatedRows.reduce((sum, r) => sum + r.employeeTake, 0);

  return {
    ...summary,
    rows: updatedRows,
    grossBilled: Math.round(grossBilled * 100) / 100,
    employeePay: Math.round(employeePay * 100) / 100,
    netPay: Math.round((employeePay - summary.deductions) * 100) / 100,
  };
}

// ─── Deductions ──────────────────────────────────────────────────────────────

export type DeductionType = 'one_time' | 'recurring';
export type AmountType = 'flat' | 'percentage';
export type DeductionFrequency = 'weekly' | 'biweekly' | 'monthly';

export const DEDUCTION_PRESETS = [
  'Equipment Damage',
  'Fuel',
  'Tow/Recovery',
  'Advance',
  'Uniform/PPE',
  'Tool Replacement',
  'Other',
];

export interface Deduction {
  id: string;
  driverName: string;
  driverHash?: string;
  companyId?: string;
  reason: string;
  deductionType: DeductionType;
  frequency?: DeductionFrequency;
  amountType: AmountType;
  amountPerPeriod: number;    // flat $ or % per pay period
  totalOwed: number;          // total to collect (0 = one-time, full amount)
  totalCollected: number;     // how much collected so far
  active: boolean;
  createdAt: any;             // Firestore Timestamp
  notes?: string;
}

export async function fetchDeductions(companyId?: string): Promise<Deduction[]> {
  const db = getFirestoreDb();
  // Simple query — deductions collection is always small, filter client-side
  const snapshot = await getDocs(collection(db, 'deductions'));
  const results: Deduction[] = [];
  snapshot.docs.forEach(docSnap => {
    const d = docSnap.data();
    if (d.active === false) return; // skip inactive
    results.push({
      id: docSnap.id,
      driverName: d.driverName || '',
      driverHash: d.driverHash || '',
      companyId: d.companyId || '',
      reason: d.reason || '',
      deductionType: d.deductionType || 'one_time',
      frequency: d.frequency,
      amountType: d.amountType || 'flat',
      amountPerPeriod: d.amountPerPeriod || 0,
      totalOwed: d.totalOwed || 0,
      totalCollected: d.totalCollected || 0,
      active: true,
      createdAt: d.createdAt,
      notes: d.notes || '',
    });
  });
  // Sort by createdAt desc
  results.sort((a, b) => {
    const aTime = a.createdAt?.toMillis?.() || 0;
    const bTime = b.createdAt?.toMillis?.() || 0;
    return bTime - aTime;
  });
  return results;
}

export async function saveDeduction(deduction: Omit<Deduction, 'id'>): Promise<string> {
  const db = getFirestoreDb();
  const docRef = doc(collection(db, 'deductions'));
  await setDoc(docRef, {
    ...deduction,
    createdAt: Timestamp.now(),
  });
  return docRef.id;
}

export async function updateDeduction(id: string, updates: Partial<Deduction>): Promise<void> {
  const db = getFirestoreDb();
  await updateDoc(doc(db, 'deductions', id), updates);
}

export async function deactivateDeduction(id: string): Promise<void> {
  const db = getFirestoreDb();
  await updateDoc(doc(db, 'deductions', id), { active: false });
}

// Calculate deduction amount for a single pay period
export function calculatePeriodDeduction(deduction: Deduction, employeePay: number): number {
  if (!deduction.active) return 0;

  if (deduction.deductionType === 'one_time') {
    // One-time: deduct full amount (minus anything already collected)
    const remaining = deduction.totalOwed - deduction.totalCollected;
    return remaining > 0 ? remaining : 0;
  }

  // Recurring
  const remaining = deduction.totalOwed - deduction.totalCollected;
  if (remaining <= 0) return 0;

  let periodAmount: number;
  if (deduction.amountType === 'percentage') {
    periodAmount = employeePay * (deduction.amountPerPeriod / 100);
  } else {
    periodAmount = deduction.amountPerPeriod;
  }

  // Don't deduct more than remaining balance
  return Math.min(periodAmount, remaining);
}

// ─── Format Helpers ──────────────────────────────────────────────────────────

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function formatPeriodRange(period: PayPeriod): string {
  return `${formatPeriodDate(period.start)} – ${formatPeriodDate(period.end)}`;
}
