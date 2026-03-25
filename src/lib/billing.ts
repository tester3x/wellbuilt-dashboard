import { getFirestoreDb } from './firebase';
import { collection, getDocs, query, where, orderBy, Timestamp, doc, setDoc, updateDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { type CompanyConfig, type OperatorBillingConfig } from './companySettings';
import { lookupRate, getEffectiveRate, formatCurrency, type PayPeriod, type CompanyRateSheets } from './payroll';

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
  detentionPay: number;
  swdWaitMinutes: number;
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
  totalDetentionPay: number;
  grandTotal: number;
  lineItems: BillingLineItem[];
  billingConfig?: OperatorBillingConfig;
  paymentTerms: string;
  /** The diesel price used for FSC calculations (historical, not current) */
  dieselPriceUsed?: number;
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
  totalDetentionPay: number;
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
  totalHours: number,
  driveDistanceMiles: number,
  currentDieselPrice: number | undefined
): number {
  if (!config || config.fuelSurchargeMethod === 'none') return 0;

  switch (config.fuelSurchargeMethod) {
    case 'hourly': {
      // DOE-automated: (diesel - baseline) / MPG × speed = $/hr × total job hours
      const diesel = currentDieselPrice || 0;
      const baseline = config.fuelSurchargeBaseline || 0;
      const mpg = config.fuelSurchargeMPG || 6;
      const speed = config.fuelSurchargeSpeed || 30;
      if (diesel <= baseline) return 0;
      const perHour = ((diesel - baseline) / mpg) * speed;
      return Math.round(totalHours * perHour * 100) / 100;
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
    case 'flat_doe': {
      // Bakken-style DOE-tiered FSC — paid per HOUR
      // Rate = multiplier × (floor(DOE / step) × step − baseline)
      // Then: clamp(rate, floor, ceiling) × total job hours = FSC for this load
      const diesel = currentDieselPrice || 0;
      const baseline = config.fuelSurchargeBaseline || 3.25;
      const multiplier = config.fuelSurchargeMultiplier || 8;
      const step = config.fuelSurchargeStep || 0.10;
      const floor = config.fuelSurchargeFloor;
      const ceiling = config.fuelSurchargeCeiling;
      const stepped = Math.floor(diesel / step) * step;
      const diff = stepped - baseline;
      if (diff <= 0) return floor ? Math.round(totalHours * floor * 100) / 100 : 0;
      let perHour = multiplier * diff;
      if (floor && perHour < floor) perHour = floor;
      if (ceiling && perHour > ceiling) perHour = ceiling;
      return Math.round(totalHours * perHour * 100) / 100;
    }
    default:
      return 0;
  }
}

/** Get the calculated FSC rate ($/hr, $/mi, etc.) for display */
export function getFuelSurchargeRate(
  config: OperatorBillingConfig | undefined,
  currentDieselPrice: number | undefined
): { rate: number; unit: string } | null {
  if (!config || config.fuelSurchargeMethod === 'none') return null;
  const diesel = currentDieselPrice || 0;

  switch (config.fuelSurchargeMethod) {
    case 'hourly': {
      const baseline = config.fuelSurchargeBaseline || 0;
      const mpg = config.fuelSurchargeMPG || 6;
      const speed = config.fuelSurchargeSpeed || 30;
      if (diesel <= baseline) return { rate: 0, unit: '/hr' };
      return { rate: Math.round(((diesel - baseline) / mpg) * speed * 100) / 100, unit: '/hr' };
    }
    case 'per_mile': {
      const baseline = config.fuelSurchargeBaseline || 0;
      const mpg = config.fuelSurchargeMPG || 6;
      if (diesel <= baseline) return { rate: 0, unit: '/mi' };
      return { rate: Math.round(((diesel - baseline) / mpg) * 100) / 100, unit: '/mi' };
    }
    case 'flat_doe': {
      const baseline = config.fuelSurchargeBaseline || 3.25;
      const multiplier = config.fuelSurchargeMultiplier || 8;
      const step = config.fuelSurchargeStep || 0.10;
      const floor = config.fuelSurchargeFloor;
      const ceiling = config.fuelSurchargeCeiling;
      const stepped = Math.floor(diesel / step) * step;
      const diff = stepped - baseline;
      if (diff <= 0) return { rate: floor || 0, unit: '/hr' };
      let perHour = Math.round(multiplier * diff * 100) / 100;
      if (floor && perHour < floor) perHour = floor;
      if (ceiling && perHour > ceiling) perHour = ceiling;
      return { rate: perHour, unit: '/hr' };
    }
    case 'percentage': return { rate: (config.fuelSurchargePercent || 0) * 100, unit: '%' };
    case 'flat': return { rate: config.fuelSurchargeRate || 0, unit: '/load' };
    default: return null;
  }
}

export function getFuelSurchargeLabel(config: OperatorBillingConfig | undefined): string {
  if (!config || config.fuelSurchargeMethod === 'none') return 'None';
  switch (config.fuelSurchargeMethod) {
    case 'hourly': return `DOE/hr (${config.fuelSurchargeMPG || 6}MPG, ${config.fuelSurchargeSpeed || 30}mph)`;
    case 'per_mile': return `DOE/mi (${config.fuelSurchargeMPG || 6}MPG)`;
    case 'percentage': return `${((config.fuelSurchargePercent || 0) * 100).toFixed(1)}%`;
    case 'flat': return `$${config.fuelSurchargeRate || 0}/load`;
    case 'flat_doe': {
      let label = `DOE/hr (x${config.fuelSurchargeMultiplier || 8}, base $${config.fuelSurchargeBaseline || 3.25})`;
      if (config.fuelSurchargeFloor || config.fuelSurchargeCeiling) {
        const parts = [];
        if (config.fuelSurchargeFloor) parts.push(`min $${config.fuelSurchargeFloor}`);
        if (config.fuelSurchargeCeiling) parts.push(`max $${config.fuelSurchargeCeiling}`);
        label += ` [${parts.join(', ')}]`;
      }
      return label;
    }
    default: return 'None';
  }
}

// ─── Historical Diesel Price Lookup ──────────────────────────────────────────

/** Normalize date string to YYYY-MM-DD for consistent comparison.
 * Invoice dates are stored as MM/DD/YYYY, diesel prices as YYYY-MM-DD. */
function normalizeToYMD(dateStr: string): string {
  if (!dateStr) return '';
  // Already YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);
  // MM/DD/YYYY → YYYY-MM-DD
  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  return dateStr;
}

/** Sorted array of {date, price} for a company, loaded once per billing query */
interface DieselPriceTimeline {
  entries: { date: string; price: number }[];
}

/**
 * Load all diesel prices for a company into a sorted timeline.
 * Called once per company per billing query — very few entries (~52/year).
 */
async function loadDieselPriceTimeline(companyId: string): Promise<DieselPriceTimeline> {
  const db = getFirestoreDb();
  const q = query(
    collection(db, 'diesel_prices'),
    where('companyId', '==', companyId),
    orderBy('date', 'asc')
  );
  const snap = await getDocs(q);
  const entries = snap.docs.map(d => ({ date: d.data().date as string, price: d.data().price as number }));
  return { entries };
}

/**
 * Get the diesel price in effect on a specific date (per-invoice lookup).
 * Finds the most recent price BEFORE the given date (strictly less than).
 * EIA publishes on Monday — that price takes effect Tuesday.
 * Monday loads use last week's price (drivers dispatched before new price known).
 */
function getDieselPriceForDate(timeline: DieselPriceTimeline, dateStr: string): number | undefined {
  if (timeline.entries.length === 0) return undefined;

  let bestPrice: number | undefined;
  for (const entry of timeline.entries) {
    if (entry.date < dateStr) {
      bestPrice = entry.price;
    } else {
      break; // sorted ascending
    }
  }
  // If no price on or before this date, use earliest as stable fallback
  return bestPrice ?? timeline.entries[0].price;
}

// ─── Fetch + Aggregate Billing Data ──────────────────────────────────────────

export async function fetchBillingData(
  period: PayPeriod,
  companyConfigs: Map<string, CompanyConfig>,
  companyId?: string,
  wellCountyMap?: Map<string, string>,
): Promise<OperatorBillingSummary[]> {
  const db = getFirestoreDb();

  const constraints = [
    where('createdAt', '>=', Timestamp.fromDate(period.start)),
    where('createdAt', '<=', Timestamp.fromDate(period.end)),
    orderBy('createdAt', 'asc'),
  ];

  const q = query(collection(db, 'invoices'), ...constraints);
  const snapshot = await getDocs(q);

  // Pre-load diesel price timelines (one query per company, reused per-invoice)
  const dieselTimelines = new Map<string, DieselPriceTimeline>();
  for (const [cid] of companyConfigs) {
    if (companyId && cid !== companyId) continue;
    dieselTimelines.set(cid, await loadDieselPriceTimeline(cid));
  }

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
    // Per-invoice diesel price: uses the price in effect on the invoice date,
    // so Monday loads get last week's FSC and Tuesday-Sunday get this week's
    const invoiceDate = normalizeToYMD(d.date || d.createdAt?.toDate?.()?.toISOString?.()?.split('T')?.[0] || '');
    const timeline = invoiceCompanyId ? dieselTimelines.get(invoiceCompanyId) : undefined;
    const currentDiesel = (timeline && invoiceDate ? getDieselPriceForDate(timeline, invoiceDate) : undefined) ?? company?.currentDieselPrice;

    const rateEntry = lookupRate(rateSheets, operator, jobType);
    const rateMethod = rateEntry?.method || 'per_bbl';
    const wellName = d.wellName || '';
    const county = d.county || wellCountyMap?.get(wellName.toLowerCase()) || '';
    const rate = rateEntry
      ? getEffectiveRate(rateEntry, invoiceDate, county, company?.payConfig?.frostZones, company?.payConfig?.frostSeason, bbls)
      : 0;
    const baseAmount = rateMethod === 'per_bbl'
      ? Math.round(bbls * rate * 100) / 100
      : Math.round(hours * rate * 100) / 100;

    const fuelSurcharge = calculateFuelSurcharge(
      billingConfig, baseAmount, hours, driveDistanceMiles, currentDiesel
    );

    // Detention pay: for per_bbl jobs where driver waited at SWD past threshold
    const swdWaitMinutes = d.swdWaitMinutes || 0;
    let detentionPay = 0;
    if (rateMethod === 'per_bbl' && billingConfig?.detentionEnabled && swdWaitMinutes > 0) {
      const threshold = billingConfig.detentionThresholdMinutes || 60;
      if (swdWaitMinutes > threshold) {
        const billableMinutes = swdWaitMinutes - threshold;
        // Rate: use configured detention rate, or fall back to operator's hourly rate from rate sheet
        let detentionRate = billingConfig.detentionHourlyRate || 0;
        if (!detentionRate) {
          const hourlyEntry = rateSheets[operator]?.find(r => r.method === 'hourly');
          detentionRate = hourlyEntry?.rate || 0;
        }
        detentionPay = Math.round((billableMinutes / 60) * detentionRate * 100) / 100;
      }
    }

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
      detentionPay,
      swdWaitMinutes,
      total: Math.round((baseAmount + fuelSurcharge + detentionPay) * 100) / 100,
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

    // For the summary-level diesel price, use the latest price from any invoice in this period
    const opTimeline = opCompanyId ? dieselTimelines.get(opCompanyId) : undefined;
    const lastItemDate = normalizeToYMD(items[items.length - 1]?.date || '');
    const summaryDiesel = (opTimeline && lastItemDate ? getDieselPriceForDate(opTimeline, lastItemDate) : undefined) ?? company?.currentDieselPrice;

    summaries.push({
      operator,
      companyId: opCompanyId,
      dieselPriceUsed: summaryDiesel,
      loads: items.length,
      totalBBLs: Math.round(items.reduce((s, i) => s + i.bbls, 0)),
      totalHours: Math.round(items.reduce((s, i) => s + i.hours, 0) * 100) / 100,
      totalFuelMinutes: items.reduce((s, i) => s + i.fuelMinutes, 0),
      subtotal: Math.round(items.reduce((s, i) => s + i.baseAmount, 0) * 100) / 100,
      totalFuelSurcharge: Math.round(items.reduce((s, i) => s + i.fuelSurcharge, 0) * 100) / 100,
      totalDetentionPay: Math.round(items.reduce((s, i) => s + i.detentionPay, 0) * 100) / 100,
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

export function calculateDueDate(periodEnd: Date, terms: string): Date {
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
    totalDetentionPay: summary.totalDetentionPay,
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
  updatedBy: string,
  /** Optional date override (YYYY-MM-DD). EIA fetches should pass the EIA period date, not today. */
  dateOverride?: string
): Promise<void> {
  const db = getFirestoreDb();
  const today = dateOverride || new Date().toISOString().split('T')[0];

  // Check if we already have a price for this company today — one save per day
  const existingSnap = await getDocs(
    query(
      collection(db, 'diesel_prices'),
      where('companyId', '==', companyId),
      where('date', '==', today)
    )
  );

  if (existingSnap.empty) {
    // First save today — create new history entry
    const priceRef = doc(collection(db, 'diesel_prices'));
    await setDoc(priceRef, {
      companyId,
      price,
      date: today,
      source,
      updatedBy,
      createdAt: Timestamp.now(),
    });
  } else {
    // Already saved today — update existing entry
    const existingDoc = existingSnap.docs[0];
    await updateDoc(existingDoc.ref, {
      price,
      source,
      updatedBy,
      updatedAt: Timestamp.now(),
    });
  }

  // Only update company's current price if this is the most recent entry
  const todayStr = new Date().toISOString().split('T')[0];
  if (today >= todayStr || !dateOverride) {
    await updateDoc(doc(db, 'companies', companyId), {
      currentDieselPrice: price,
    });
  }
}

// ─── EIA API — Auto-fetch diesel prices ─────────────────────────────────────

/** Map our DoeRegion codes to EIA API duoarea codes */
const DOE_REGION_TO_EIA: Record<string, string> = {
  us: 'NUS',
  padd1: 'R10',
  padd1a: 'R1X',
  padd1b: 'R1Y',
  padd1c: 'R1Z',
  padd2: 'R20',
  padd3: 'R30',
  padd4: 'R40',
  padd5: 'R50',
  padd5_no_ca: 'R5XCA',
  california: 'SCA',
};

export interface EiaFetchResult {
  price: number;
  date: string;
  region: string;
}

/**
 * Fetch the latest weekly retail diesel price from the EIA API.
 * Uses the free DEMO_KEY — 30 requests/hr limit.
 * Production: get a real key from https://www.eia.gov/opendata/register.php
 */
export async function fetchEiaDieselPrice(doeRegion: string, weeks: number = 1): Promise<EiaFetchResult[]> {
  const duoarea = DOE_REGION_TO_EIA[doeRegion] || 'NUS';
  const apiKey = '8mXuoSgL8cBJv4EXnzV2g201GToEOdQRalVHo1ej';
  const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data?api_key=${apiKey}`
    + `&frequency=weekly`
    + `&data[0]=value`
    + `&facets[duoarea][]=${duoarea}`
    + `&facets[product][]=EPD2D`
    + `&sort[0][column]=period`
    + `&sort[0][direction]=desc`
    + `&length=${weeks}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`EIA API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const rows = json?.response?.data;
  if (!rows || rows.length === 0) {
    throw new Error('No diesel price data returned from EIA');
  }
  return rows
    .filter((row: any) => row.value)
    .map((row: any) => ({
      price: parseFloat(row.value),
      date: row.period || new Date().toISOString().split('T')[0],
      region: row['duoarea-name'] || doeRegion,
    }));
}

export async function deleteDieselPrice(priceId: string): Promise<void> {
  const db = getFirestoreDb();
  await deleteDoc(doc(db, 'diesel_prices', priceId));
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
