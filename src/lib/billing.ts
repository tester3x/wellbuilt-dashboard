import { getFirestoreDb } from './firebase';
import { collection, getDocs, query, where, orderBy, Timestamp, doc, setDoc, updateDoc, getDoc } from 'firebase/firestore';
import { type CompanyConfig, type OperatorBillingConfig } from './companySettings';
import { lookupRate, formatCurrency, type PayPeriod, type CompanyRateSheets } from './payroll';

// Re-export for convenience
export { formatCurrency, type PayPeriod };
export { getPayPeriods, formatPeriodRange } from './payroll';

// ─── Types ───────────────────────────────────────────────────────────────────

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
  total: number;
}

export interface OperatorBillingSummary {
  operator: string;
  companyId: string;
  loads: number;
  totalBBLs: number;
  totalHours: number;
  totalFuelMinutes: number;
  subtotal: number;
  totalFuelSurcharge: number;
  grandTotal: number;
  lineItems: BillingLineItem[];
  billingConfig?: OperatorBillingConfig;
  paymentTerms: string;
}

export type BillingStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'partial';

export interface BillingRecord {
  id: string;
  billingNumber: string;
  companyId: string;
  operator: string;
  periodStart: any;
  periodEnd: any;
  invoiceIds: string[];
  lineItems: BillingLineItem[];
  subtotal: number;
  totalFuelSurcharge: number;
  grandTotal: number;
  paymentTerms: string;
  dueDate: any;
  status: BillingStatus;
  amountPaid: number;
  sentAt?: any;
  paidAt?: any;
  createdAt: any;
  notes?: string;
}

export interface DieselPriceEntry {
  id: string;
  price: number;
  date: string;
  source: string;
  updatedBy: string;
  createdAt: any;
}

export function getBillingStatusColor(status: BillingStatus): string {
  switch (status) {
    case 'draft': return 'bg-gray-600/20 text-gray-400';
    case 'sent': return 'bg-blue-600/20 text-blue-400';
    case 'paid': return 'bg-green-600 text-white';
    case 'overdue': return 'bg-red-600/20 text-red-400';
    case 'partial': return 'bg-yellow-600/20 text-yellow-400';
    default: return 'bg-gray-600/20 text-gray-400';
  }
}

// ─── Fuel Surcharge Calculation ──────────────────────────────────────────────

export function calculateFuelSurcharge(
  config: OperatorBillingConfig | undefined,
  baseAmount: number,
  fuelMinutes: number,
  driveDistanceMiles: number,
  currentDieselPrice: number | undefined
): number {
  if (!config || config.fuelSurchargeMethod === 'none') return 0;

  switch (config.fuelSurchargeMethod) {
    case 'hourly': {
      const hours = fuelMinutes / 60;
      return Math.round(hours * (config.fuelSurchargeRate || 0) * 100) / 100;
    }
    case 'per_mile': {
      const diesel = currentDieselPrice || 0;
      const baseline = config.fuelSurchargeBaseline || 0;
      const mpg = config.fuelSurchargeMPG || 6;
      if (diesel <= baseline) return 0;
      const perMile = (diesel - baseline) / mpg;
      return Math.round(perMile * (driveDistanceMiles || 0) * 100) / 100;
    }
    case 'percentage': {
      return Math.round(baseAmount * (config.fuelSurchargePercent || 0) * 100) / 100;
    }
    case 'flat': {
      return config.fuelSurchargeRate || 0;
    }
    default:
      return 0;
  }
}

export function getFuelSurchargeLabel(config: OperatorBillingConfig | undefined): string {
  if (!config || config.fuelSurchargeMethod === 'none') return 'None';
  switch (config.fuelSurchargeMethod) {
    case 'hourly': return `$${config.fuelSurchargeRate || 0}/hr`;
    case 'per_mile': return `DOE-based (${config.fuelSurchargeMPG || 6} MPG)`;
    case 'percentage': return `${((config.fuelSurchargePercent || 0) * 100).toFixed(1)}%`;
    case 'flat': return `$${config.fuelSurchargeRate || 0}/load`;
    default: return 'None';
  }
}

// ─── Fetch + Aggregate Billing Data ──────────────────────────────────────────

export async function fetchBillingData(
  period: PayPeriod,
  companyConfigs: Map<string, CompanyConfig>,
  companyId?: string
): Promise<OperatorBillingSummary[]> {
  const db = getFirestoreDb();

  const constraints = [
    where('createdAt', '>=', Timestamp.fromDate(period.start)),
    where('createdAt', '<=', Timestamp.fromDate(period.end)),
    orderBy('createdAt', 'asc'),
  ];

  const q = query(collection(db, 'invoices'), ...constraints);
  const snapshot = await getDocs(q);

  // Group by operator
  const operatorMap = new Map<string, { items: BillingLineItem[]; companyId: string }>();

  snapshot.docs.forEach(docSnap => {
    const d = docSnap.data();
    const status = d.status || 'open';
    if (status === 'open') return;

    const operator = d.operator || '';
    if (!operator) return;

    const invoiceCompanyId = d.companyId || '';
    // Company scoping
    if (companyId && invoiceCompanyId && invoiceCompanyId !== companyId) return;

    const jobType = d.commodityType || d.jobType || '';
    const bbls = d.totalBBL || 0;
    const hours = d.totalHours || 0;
    const fuelMinutes = d.fuelMinutes || 0;
    const driveDistanceMiles = d.driveDistanceMiles || 0;

    // Rate lookup
    const company = invoiceCompanyId ? companyConfigs.get(invoiceCompanyId) : null;
    const rateSheets = company?.rateSheets || {};
    const billingConfig = company?.billingConfig?.[operator];
    const currentDiesel = company?.currentDieselPrice;

    const rateEntry = lookupRate(rateSheets, operator, jobType);
    const rate = rateEntry?.rate || 0;
    const rateMethod = rateEntry?.method || 'per_bbl';
    const baseAmount = rateMethod === 'per_bbl'
      ? Math.round(bbls * rate * 100) / 100
      : Math.round(hours * rate * 100) / 100;

    const fuelSurcharge = calculateFuelSurcharge(
      billingConfig, baseAmount, fuelMinutes, driveDistanceMiles, currentDiesel
    );

    const item: BillingLineItem = {
      invoiceId: docSnap.id,
      invoiceNumber: d.invoiceNumber || '',
      date: d.date || '',
      wellName: d.wellName || '',
      hauledTo: d.hauledTo || '',
      driver: d.driver || '',
      jobType,
      bbls,
      hours,
      fuelMinutes,
      driveDistanceMiles,
      rateMethod,
      rate,
      baseAmount,
      fuelSurcharge,
      total: Math.round((baseAmount + fuelSurcharge) * 100) / 100,
    };

    if (!operatorMap.has(operator)) {
      operatorMap.set(operator, { items: [], companyId: invoiceCompanyId });
    }
    operatorMap.get(operator)!.items.push(item);
    if (invoiceCompanyId) {
      operatorMap.get(operator)!.companyId = invoiceCompanyId;
    }
  });

  // Build summaries
  const summaries: OperatorBillingSummary[] = [];

  operatorMap.forEach(({ items, companyId: opCompanyId }, operator) => {
    items.sort((a, b) => a.date.localeCompare(b.date));

    const company = opCompanyId ? companyConfigs.get(opCompanyId) : null;
    const billingConfig = company?.billingConfig?.[operator];
    const paymentTerms = billingConfig?.paymentTerms || 'net_30';

    summaries.push({
      operator,
      companyId: opCompanyId,
      loads: items.length,
      totalBBLs: Math.round(items.reduce((s, i) => s + i.bbls, 0)),
      totalHours: Math.round(items.reduce((s, i) => s + i.hours, 0) * 100) / 100,
      totalFuelMinutes: items.reduce((s, i) => s + i.fuelMinutes, 0),
      subtotal: Math.round(items.reduce((s, i) => s + i.baseAmount, 0) * 100) / 100,
      totalFuelSurcharge: Math.round(items.reduce((s, i) => s + i.fuelSurcharge, 0) * 100) / 100,
      grandTotal: Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100,
      lineItems: items,
      billingConfig,
      paymentTerms,
    });
  });

  summaries.sort((a, b) => a.operator.localeCompare(b.operator));
  return summaries;
}

// ─── Billing Record CRUD ─────────────────────────────────────────────────────

function calculateDueDate(periodEnd: Date, terms: string): Date {
  const due = new Date(periodEnd);
  switch (terms) {
    case 'net_30': due.setDate(due.getDate() + 30); break;
    case 'net_60': due.setDate(due.getDate() + 60); break;
    case 'net_90': due.setDate(due.getDate() + 90); break;
    case 'due_on_receipt': break; // same as period end
  }
  return due;
}

export async function getNextBillingNumber(companyId: string): Promise<string> {
  const db = getFirestoreDb();
  const year = new Date().getFullYear();
  const counterRef = doc(db, 'billing_counters', companyId);
  const counterSnap = await getDoc(counterRef);

  let nextNum = 1;
  if (counterSnap.exists()) {
    const data = counterSnap.data();
    if (data.year === year) {
      nextNum = (data.counter || 0) + 1;
    }
  }

  await setDoc(counterRef, { year, counter: nextNum });
  return `BILL-${year}-${String(nextNum).padStart(3, '0')}`;
}

export async function generateBillingRecord(
  summary: OperatorBillingSummary,
  period: PayPeriod,
  companyId: string
): Promise<string> {
  const db = getFirestoreDb();
  const billingNumber = await getNextBillingNumber(companyId);
  const dueDate = calculateDueDate(period.end, summary.paymentTerms);

  const record: Omit<BillingRecord, 'id'> = {
    billingNumber,
    companyId,
    operator: summary.operator,
    periodStart: Timestamp.fromDate(period.start),
    periodEnd: Timestamp.fromDate(period.end),
    invoiceIds: summary.lineItems.map(li => li.invoiceId),
    lineItems: summary.lineItems,
    subtotal: summary.subtotal,
    totalFuelSurcharge: summary.totalFuelSurcharge,
    grandTotal: summary.grandTotal,
    paymentTerms: summary.paymentTerms,
    dueDate: Timestamp.fromDate(dueDate),
    status: 'draft',
    amountPaid: 0,
    createdAt: Timestamp.now(),
  };

  const docRef = doc(collection(db, 'billing_invoices'));
  await setDoc(docRef, record);
  return docRef.id;
}

export async function fetchBillingRecords(
  period: PayPeriod,
  companyId?: string
): Promise<BillingRecord[]> {
  const db = getFirestoreDb();

  const constraints = [
    where('periodStart', '>=', Timestamp.fromDate(period.start)),
    where('periodStart', '<=', Timestamp.fromDate(period.end)),
    orderBy('periodStart', 'asc'),
  ];

  const q = query(collection(db, 'billing_invoices'), ...constraints);
  const snapshot = await getDocs(q);
  const results: BillingRecord[] = [];

  snapshot.docs.forEach(docSnap => {
    const d = docSnap.data();
    if (companyId && d.companyId !== companyId) return;
    results.push({ id: docSnap.id, ...d } as BillingRecord);
  });

  return results;
}

export async function updateBillingStatus(
  billingId: string,
  status: BillingStatus,
  amountPaid?: number
): Promise<void> {
  const db = getFirestoreDb();
  const updates: Record<string, any> = { status };
  if (amountPaid !== undefined) updates.amountPaid = amountPaid;
  if (status === 'sent') updates.sentAt = Timestamp.now();
  if (status === 'paid') updates.paidAt = Timestamp.now();
  await updateDoc(doc(db, 'billing_invoices', billingId), updates);
}

// ─── Diesel Price Tracking ───────────────────────────────────────────────────

export async function saveDieselPrice(
  companyId: string,
  price: number,
  source: string,
  updatedBy: string
): Promise<void> {
  const db = getFirestoreDb();

  // Save to price history
  const priceRef = doc(collection(db, 'diesel_prices'));
  await setDoc(priceRef, {
    companyId,
    price,
    date: new Date().toISOString().split('T')[0],
    source,
    updatedBy,
    createdAt: Timestamp.now(),
  });

  // Update company's current price
  await updateDoc(doc(db, 'companies', companyId), {
    currentDieselPrice: price,
  });
}

export async function fetchDieselPriceHistory(companyId?: string): Promise<DieselPriceEntry[]> {
  const db = getFirestoreDb();
  const snapshot = await getDocs(
    query(collection(db, 'diesel_prices'), orderBy('createdAt', 'desc'))
  );

  const results: DieselPriceEntry[] = [];
  snapshot.docs.forEach(docSnap => {
    const d = docSnap.data();
    if (companyId && d.companyId !== companyId) return;
    results.push({
      id: docSnap.id,
      price: d.price || 0,
      date: d.date || '',
      source: d.source || '',
      updatedBy: d.updatedBy || '',
      createdAt: d.createdAt,
    });
  });

  return results.slice(0, 52); // last year of weekly entries
}
