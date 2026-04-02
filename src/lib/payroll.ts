import { getFirestoreDb } from './firebase';
import { collection, getDocs, query, where, orderBy, Timestamp, doc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { type CompanyConfig, type PayConfig, type FrostSeason, type FrostZone, JOB_TYPE_ALIASES } from './companySettings';

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
  frostRate?: number;
  frostRates?: Record<string, number>;
}

// ─── Frost Season Helper ────────────────────────────────────────────────────

/** Normalize date to YYYY-MM-DD for comparison. Handles MM/DD/YYYY (invoice format) and YYYY-MM-DD (date picker). */
function toISODate(dateStr: string): string {
  if (!dateStr) return '';
  // Already YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  // MM/DD/YYYY → YYYY-MM-DD
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return dateStr;
}

/** Check if a date falls within a frost zone's active period */
function isInFrostZone(isoDate: string, zone: FrostZone): boolean {
  if (!zone.startDate) return false;
  const afterStart = isoDate >= zone.startDate;
  const beforeEnd = !zone.endDate || isoDate <= zone.endDate;
  return afterStart && beforeEnd;
}

/**
 * Returns the effective rate for a rate entry, using frost rate if the date
 * falls within an active frost zone for the invoice's county.
 *
 * If the load exceeds the county's maxBbls frost limit, falls back to normal rate.
 * Priority: frostZones[county] + frostRates[county] → legacy frostSeason + frostRate
 */
export function getEffectiveRate(
  entry: RateEntry,
  invoiceDate: string,
  county: string,
  frostZones?: Record<string, FrostZone>,
  legacyFrostSeason?: FrostSeason,
  bbls?: number,
): number {
  if (entry.method !== 'per_bbl') return entry.rate;
  const isoDate = toISODate(invoiceDate);
  if (!isoDate) return entry.rate;

  // Per-county frost zones (new system)
  if (frostZones) {
    // Case-insensitive county lookup (NDIC stores "MCKENZIE", config stores "McKenzie")
    const countyLower = county.toLowerCase();
    const matchedCounty = Object.keys(frostZones).find(k => k.toLowerCase() === countyLower);
    // Use matched county, or fall back to "All Counties" catch-all
    const effectiveCounty = matchedCounty || (frostZones['All Counties'] ? 'All Counties' : '');
    if (effectiveCounty) {
      const zone = frostZones[effectiveCounty];
      if (zone && isInFrostZone(isoDate, zone)) {
        // BBL limit check: use the well's actual county zone limit first,
        // then fall back to the effective zone's limit. County road weight
        // limits apply regardless of which zone provides the rate.
        const countyZone = matchedCounty ? frostZones[matchedCounty] : undefined;
        const maxBbls = countyZone?.maxBbls || zone.maxBbls;
        if (maxBbls && bbls && bbls > maxBbls) return entry.rate;
        // Check per-county frost rate (try exact matched county first, then effectiveCounty)
        const countyRate = matchedCounty
          ? (entry.frostRates?.[matchedCounty] ?? entry.frostRates?.[effectiveCounty])
          : entry.frostRates?.[effectiveCounty];
        if (countyRate && countyRate > 0) return countyRate;
        // Fall back to legacy single frost rate
        if (entry.frostRate && entry.frostRate > 0) return entry.frostRate;
      }
    }
  }

  // Legacy single frost season (backward compat)
  if (legacyFrostSeason?.startDate && entry.frostRate && entry.frostRate > 0) {
    if (isInFrostZone(isoDate, { startDate: legacyFrostSeason.startDate, endDate: legacyFrostSeason.endDate || '' })) {
      return entry.frostRate;
    }
  }

  return entry.rate;
}

// ─── Well → County Lookup ───────────────────────────────────────────────────

/** Build a map of wellName (lowercase) → county from Firestore wells collection */
export async function buildWellCountyMap(operators: string[]): Promise<Map<string, string>> {
  const db = getFirestoreDb();
  const countyMap = new Map<string, string>();
  if (operators.length === 0) return countyMap;

  // Load wells for each operator
  for (const op of operators) {
    try {
      const q = query(collection(db, 'wells'), where('operator', '==', op));
      const snap = await getDocs(q);
      snap.docs.forEach(d => {
        const data = d.data();
        if (data.well_name && data.county) {
          countyMap.set(data.well_name.toLowerCase(), data.county);
        }
      });
    } catch {
      // Skip operator on error
    }
  }
  return countyMap;
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
  detentionPay: number;
  swdWaitMinutes: number;
  employeeTake: number;
  tickets: string[];
  flagged?: boolean;
  flagNote?: string;
}

export interface DriverTimesheetSummary {
  driverName: string;
  legalName?: string;
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
  additions: number;
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

  // Direct match first
  const direct = operatorRates.find(r => r.jobType === jobType);
  if (direct) return direct;

  // Try alias match (legacy rate sheet entries → current commodity types)
  // Check both directions: invoice jobType might match an alias key, or
  // rate sheet entry might use a legacy name that aliases to the invoice jobType
  for (const entry of operatorRates) {
    const normalizedEntry = JOB_TYPE_ALIASES[entry.jobType] || entry.jobType;
    const normalizedJob = JOB_TYPE_ALIASES[jobType] || jobType;
    if (normalizedEntry === jobType || entry.jobType === normalizedJob || normalizedEntry === normalizedJob) {
      return entry;
    }
  }

  return null;
}

// ─── Fetch Payroll Data ──────────────────────────────────────────────────────

export async function fetchPayrollInvoices(
  period: PayPeriod,
  companyConfigs: Map<string, CompanyConfig>,
  companyId?: string,
  wellCountyMap?: Map<string, string>,
  legalNameMap?: Record<string, string>,
): Promise<DriverTimesheetSummary[]> {
  const db = getFirestoreDb();

  // Query invoices within the pay period date range
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
  const driverMap = new Map<string, { rows: DriverTimesheetRow[]; companyId?: string }>();

  snapshot.docs.forEach(docSnap => {
    const d = docSnap.data();

    // Skip open/in-progress invoices — only count closed+
    const status = d.status || 'open';
    if (status === 'open') return;

    const rawDriverName = d.driver || 'Unknown';
    // Group by legal name so all logins for the same person merge into one row
    const driverName = legalNameMap?.[rawDriverName] || rawDriverName;
    const invoiceCompanyId = d.companyId || '';
    const operator = d.operator || '';
    const jobType = d.commodityType || d.jobType || '';
    const wellName = d.wellName || '';

    // Look up county from well name (for frost rate calculation)
    const county = d.county || wellCountyMap?.get(wellName.toLowerCase()) || '';

    // Look up rate from the driver's company rate sheet
    let rate = 0;
    let amountBilled = 0;
    let employeeTake = 0;
    const company = invoiceCompanyId ? companyConfigs.get(invoiceCompanyId) : null;
    const rateSheets = company?.rateSheets || {};
    const split = company?.payConfig?.defaultSplit || 0;

    const rateEntry = lookupRate(rateSheets, operator, jobType);
    const swdWaitMinutes = d.swdWaitMinutes || 0;
    let detentionPay = 0;
    // BBLs: try totalBBL first, then fall back to ticket-level fields (s_t mode may not write totalBBL)
    const bbls = d.totalBBL || parseFloat(d.bbls || '0') || parseFloat(d.qty || '0') || 0;
    if (rateEntry) {
      const invoiceDate = d.date || '';
      rate = getEffectiveRate(rateEntry, invoiceDate, county, company?.payConfig?.frostZones, company?.payConfig?.frostSeason, bbls);
      const hours = d.totalHours || 0;
      amountBilled = rateEntry.method === 'per_bbl' ? bbls * rate : hours * rate;
      amountBilled = Math.round(amountBilled * 100) / 100;

      // Detention pay: for per_bbl jobs where driver waited at SWD past threshold
      const billingConfig = company?.billingConfig?.[operator];
      if (rateEntry.method === 'per_bbl' && billingConfig?.detentionEnabled && swdWaitMinutes > 0) {
        const threshold = billingConfig.detentionThresholdMinutes || 60;
        if (swdWaitMinutes > threshold) {
          const billableMinutes = swdWaitMinutes - threshold;
          let detentionRate = billingConfig.detentionHourlyRate || 0;
          if (!detentionRate) {
            const hourlyEntry = rateSheets[operator]?.find(r => r.method === 'hourly');
            detentionRate = hourlyEntry?.rate || 0;
          }
          detentionPay = Math.round((billableMinutes / 60) * detentionRate * 100) / 100;
        }
      }

      employeeTake = Math.round((amountBilled + detentionPay) * split * 100) / 100;
    }

    const row: DriverTimesheetRow = {
      id: docSnap.id,
      date: d.date || '',
      invoiceNumber: d.invoiceNumber || (d.tickets?.length ? d.tickets[0] : '') || wellName || '',
      operator,
      wellName: d.wellName || '',
      jobType,
      bbls,
      hours: d.totalHours || 0,
      rate,
      amountBilled,
      detentionPay,
      swdWaitMinutes,
      employeeTake,
      tickets: d.tickets || [],
    };

    if (!driverMap.has(driverName)) {
      driverMap.set(driverName, { rows: [], companyId: invoiceCompanyId });
    }
    driverMap.get(driverName)!.rows.push(row);
    // Keep the companyId from the most recent invoice
    if (invoiceCompanyId) {
      driverMap.get(driverName)!.companyId = invoiceCompanyId;
    }
  });

  // Build summaries per driver
  const summaries: DriverTimesheetSummary[] = [];

  driverMap.forEach(({ rows, companyId: driverCompanyId }, driverName) => {
    // Sort rows by date
    rows.sort((a, b) => a.date.localeCompare(b.date));

    const totalLoads = rows.length;
    const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
    const totalBBLs = rows.reduce((sum, r) => sum + r.bbls, 0);
    const grossBilled = rows.reduce((sum, r) => sum + r.amountBilled + r.detentionPay, 0);
    const employeePay = rows.reduce((sum, r) => sum + r.employeeTake, 0);

    const company = driverCompanyId ? companyConfigs.get(driverCompanyId) : null;

    summaries.push({
      driverName,
      companyId: driverCompanyId,
      companyName: company?.name,
      truckNumber: rows[0]?.invoiceNumber ? '' : '',
      totalLoads,
      totalHours: Math.round(totalHours * 100) / 100,
      totalBBLs: Math.round(totalBBLs),
      grossBilled: Math.round(grossBilled * 100) / 100,
      employeePay: Math.round(employeePay * 100) / 100,
      deductions: 0,
      additions: 0,
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
  employeeSplit: number,  // e.g. 0.25 for 25%
  frostZones?: Record<string, FrostZone>,
  legacyFrostSeason?: FrostSeason,
  wellCountyMap?: Map<string, string>
): DriverTimesheetSummary {
  const updatedRows = summary.rows.map(row => {
    const rateEntry = lookupRate(rateSheets, row.operator, row.jobType);
    if (!rateEntry) return row;

    const county = wellCountyMap?.get(row.wellName.toLowerCase()) || '';
    const rate = getEffectiveRate(rateEntry, row.date, county, frostZones, legacyFrostSeason, row.bbls);
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
  effectiveDate?: any;        // Firestore Timestamp — first pay period this applies to
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
      effectiveDate: d.effectiveDate || null,
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

// Check if a recurring item should apply to this pay period based on effectiveDate + frequency
function shouldApplyToPeriod(
  effectiveDate: any,
  frequency: DeductionFrequency | undefined,
  period: PayPeriod
): boolean {
  if (!effectiveDate) return true; // no effective date = always apply (legacy behavior)

  const effective = effectiveDate?.toDate?.() || new Date(effectiveDate);
  // Period hasn't started yet relative to effective date
  if (effective > period.end) return false;

  // For biweekly: count weeks from effectiveDate to period start, apply every other week
  if (frequency === 'biweekly') {
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const weeksDiff = Math.floor((period.start.getTime() - effective.getTime()) / msPerWeek);
    // Apply on even-numbered weeks (0, 2, 4...) from the effective date
    return weeksDiff >= 0 && weeksDiff % 2 === 0;
  }

  return true;
}

// Calculate deduction amount for a single pay period
export function calculatePeriodDeduction(deduction: Deduction, employeePay: number, period?: PayPeriod): number {
  if (!deduction.active) return 0;

  if (deduction.deductionType === 'one_time') {
    // One-time: check effectiveDate if set — must be on/before period end
    if (deduction.effectiveDate && period) {
      const effective = deduction.effectiveDate?.toDate?.() || new Date(deduction.effectiveDate);
      if (effective > period.end) return 0;
    }
    const remaining = deduction.totalOwed - deduction.totalCollected;
    return remaining > 0 ? remaining : 0;
  }

  // Recurring — check effectiveDate + frequency cadence
  if (period && !shouldApplyToPeriod(deduction.effectiveDate, deduction.frequency, period)) {
    return 0;
  }

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

// ─── Bonuses & Reimbursements ────────────────────────────────────────────────

export const BONUS_PRESETS = [
  'Sign-On Bonus',
  'Safety Bonus',
  'Performance Bonus',
  'Mileage Reimbursement',
  'Per Diem',
  'Referral Bonus',
  'Other',
];

// Reuse same shape as Deduction — stored in 'additions' Firestore collection
export interface Addition {
  id: string;
  driverName: string;
  driverHash?: string;
  companyId?: string;
  reason: string;
  additionType: DeductionType;     // 'one_time' | 'recurring'
  frequency?: DeductionFrequency;
  amountType: AmountType;          // 'flat' | 'percentage'
  amountPerPeriod: number;
  totalOwed: number;               // total to pay out (recurring)
  totalPaid: number;               // how much paid so far
  active: boolean;
  createdAt: any;
  effectiveDate?: any;             // Firestore Timestamp — first pay period this applies to
  notes?: string;
}

export async function fetchAdditions(companyId?: string): Promise<Addition[]> {
  const db = getFirestoreDb();
  const snapshot = await getDocs(collection(db, 'additions'));
  const results: Addition[] = [];
  snapshot.docs.forEach(docSnap => {
    const d = docSnap.data();
    if (d.active === false) return;
    results.push({
      id: docSnap.id,
      driverName: d.driverName || '',
      driverHash: d.driverHash || '',
      companyId: d.companyId || '',
      reason: d.reason || '',
      additionType: d.additionType || 'one_time',
      frequency: d.frequency,
      amountType: d.amountType || 'flat',
      amountPerPeriod: d.amountPerPeriod || 0,
      totalOwed: d.totalOwed || 0,
      totalPaid: d.totalPaid || 0,
      active: true,
      createdAt: d.createdAt,
      effectiveDate: d.effectiveDate || null,
      notes: d.notes || '',
    });
  });
  results.sort((a, b) => {
    const aTime = a.createdAt?.toMillis?.() || 0;
    const bTime = b.createdAt?.toMillis?.() || 0;
    return bTime - aTime;
  });
  return results;
}

export async function saveAddition(addition: Omit<Addition, 'id'>): Promise<string> {
  const db = getFirestoreDb();
  const docRef = doc(collection(db, 'additions'));
  await setDoc(docRef, {
    ...addition,
    createdAt: Timestamp.now(),
  });
  return docRef.id;
}

export async function deactivateAddition(id: string): Promise<void> {
  const db = getFirestoreDb();
  await updateDoc(doc(db, 'additions', id), { active: false });
}

export function calculatePeriodAddition(addition: Addition, employeePay: number, period?: PayPeriod): number {
  if (!addition.active) return 0;

  if (addition.additionType === 'one_time') {
    // One-time: check effectiveDate if set
    if (addition.effectiveDate && period) {
      const effective = addition.effectiveDate?.toDate?.() || new Date(addition.effectiveDate);
      if (effective > period.end) return 0;
    }
    const remaining = addition.totalOwed - addition.totalPaid;
    return remaining > 0 ? remaining : 0;
  }

  // Recurring — check effectiveDate + frequency cadence
  if (period && !shouldApplyToPeriod(addition.effectiveDate, addition.frequency, period)) {
    return 0;
  }

  const remaining = addition.totalOwed - addition.totalPaid;
  if (remaining <= 0) return 0;

  let periodAmount: number;
  if (addition.amountType === 'percentage') {
    periodAmount = employeePay * (addition.amountPerPeriod / 100);
  } else {
    periodAmount = addition.amountPerPeriod;
  }

  return Math.min(periodAmount, remaining);
}

// ─── Format Helpers ──────────────────────────────────────────────────────────

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function formatPeriodRange(period: PayPeriod): string {
  return `${formatPeriodDate(period.start)} – ${formatPeriodDate(period.end)}`;
}
