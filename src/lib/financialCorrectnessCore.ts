/**
 * financialCorrectnessCore.ts
 * Contract version 1.0.0 — Dashboard / WB-S shared financial projection.
 *
 * BYTE-IDENTICAL copy required in:
 *   Dashboard  src/lib/financialCorrectnessCore.ts
 *   WB-S       src/core/services/financialCorrectnessCore.ts
 *
 * Pure. No Firebase. No UI. Unknown / missing / ambiguous fail closed.
 * Do not invent rates, splits, unit conversions, or first-list fallbacks.
 */

export const FINANCIAL_CORRECTNESS_CONTRACT_VERSION = '1.0.0';

// ── Status eligibility ───────────────────────────────────────────────────────

/**
 * Positive allowlist of financially eligible invoice statuses.
 * Inventory (WB-T Invoice.status + Dashboard InvoiceStatus + writers):
 *   open | closed | submitted | approved | paid | transferred | transfer_pending
 *   plus writers: cancelled | void
 * Dispatch/job vocabulary that can leak onto invoices: in_progress | in-progress | paused | completed
 * Only completed financial states enter money projections. transferred / transfer_pending
 * are terminal-or-in-flight but not billable/payable on the source invoice.
 */
export const FINANCIAL_ELIGIBLE_STATUSES = ['closed', 'completed', 'submitted', 'approved', 'paid'] as const;

export type FinancialEligibilityReason =
  | 'explicitly_completed'
  | 'open'
  | 'in_progress'
  | 'paused'
  | 'cancelled'
  | 'void'
  | 'missing'
  | 'malformed'
  | 'unknown'
  | 'not_financially_eligible';

export type FinancialEligibility =
  | { eligible: true; status: string; reason: 'explicitly_completed' }
  | { eligible: false; status: string; reason: Exclude<FinancialEligibilityReason, 'explicitly_completed'> };

const INELIGIBLE_NAMED: Record<string, Exclude<FinancialEligibilityReason, 'explicitly_completed' | 'malformed' | 'missing' | 'unknown'>> = {
  open: 'open',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  paused: 'paused',
  cancelled: 'cancelled',
  void: 'void',
  transferred: 'not_financially_eligible',
  transfer_pending: 'not_financially_eligible',
};

export function normalizeFinancialStatus(raw: unknown): { status: string; kind: 'missing' | 'malformed' | 'known' } {
  if (raw === undefined || raw === null || raw === '') {
    return { status: '', kind: 'missing' };
  }
  if (typeof raw !== 'string') {
    return { status: String(raw), kind: 'malformed' };
  }
  const status = raw.trim();
  if (!status) return { status: '', kind: 'missing' };
  return { status, kind: 'known' };
}

export function isFinanciallyEligibleStatus(raw: unknown): FinancialEligibility {
  const n = normalizeFinancialStatus(raw);
  if (n.kind === 'missing') return { eligible: false, status: '', reason: 'missing' };
  if (n.kind === 'malformed') return { eligible: false, status: n.status, reason: 'malformed' };
  const key = n.status.toLowerCase();
  if ((FINANCIAL_ELIGIBLE_STATUSES as readonly string[]).includes(key)) {
    return { eligible: true, status: key, reason: 'explicitly_completed' };
  }
  if (INELIGIBLE_NAMED[key]) {
    return { eligible: false, status: key, reason: INELIGIBLE_NAMED[key] };
  }
  return { eligible: false, status: key, reason: 'unknown' };
}

// ── Quantity ─────────────────────────────────────────────────────────────────

export type QuantityUnit = 'bbl' | 'ton';

export type QuantityResolution =
  | { state: 'resolved'; value: number; unit: QuantityUnit; source: string }
  | { state: 'explicit_zero'; value: 0; unit: QuantityUnit; source: string }
  | {
      state: 'unresolved';
      reason: 'missing' | 'conflict' | 'mixed' | 'unsupported' | 'ambiguous' | 'untyped_qty';
      details: string;
    };

export interface QuantityFacts {
  totalBBL?: number | null;
  bbls?: number | null;
  qty?: number | string | null;
  qtyUnit?: string | null;
  unit?: string | null;
  tons?: number | null;
  netWeight?: number | null;
  packageId?: string | null;
}

function presentNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseMaybeNumber(v: unknown): number | null {
  if (presentNumber(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeUnitToken(raw: string | null | undefined): QuantityUnit | 'hour' | 'generic' | null {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase();
  if (!t) return null;
  if (t === 'bbl' || t === 'bbls' || t === 'barrel' || t === 'barrels') return 'bbl';
  if (t === 'ton' || t === 'tons' || t === 'net' || t === 'netweight' || t === 'net_weight') return 'ton';
  if (t === 'hr' || t === 'hrs' || t === 'hour' || t === 'hours') return 'hour';
  return 'generic';
}

function packQty(value: number, unit: QuantityUnit, source: string): QuantityResolution {
  if (value === 0) return { state: 'explicit_zero', value: 0, unit, source };
  return { state: 'resolved', value, unit, source };
}

export function resolveFinancialQuantity(facts: QuantityFacts): QuantityResolution {
  const candidates: Array<{ value: number; unit: QuantityUnit; source: string }> = [];

  if (presentNumber(facts.totalBBL)) {
    candidates.push({ value: facts.totalBBL, unit: 'bbl', source: 'totalBBL' });
  }
  if (presentNumber(facts.bbls)) {
    candidates.push({ value: facts.bbls, unit: 'bbl', source: 'bbls' });
  }
  if (presentNumber(facts.tons)) {
    candidates.push({ value: facts.tons, unit: 'ton', source: 'tons' });
  }
  if (presentNumber(facts.netWeight)) {
    candidates.push({ value: facts.netWeight, unit: 'ton', source: 'netWeight' });
  }

  const declaredUnit = normalizeUnitToken(facts.qtyUnit || facts.unit || null);
  const qtyNum = parseMaybeNumber(facts.qty);
  if (qtyNum !== null) {
    if (declaredUnit === 'bbl') {
      candidates.push({ value: qtyNum, unit: 'bbl', source: 'qty+unit:bbl' });
    } else if (declaredUnit === 'ton') {
      candidates.push({ value: qtyNum, unit: 'ton', source: 'qty+unit:ton' });
    } else if (declaredUnit === 'hour') {
      return { state: 'unresolved', reason: 'unsupported', details: 'qty declared in hours is not a haul quantity' };
    } else {
      return { state: 'unresolved', reason: 'untyped_qty', details: 'generic qty is not BBL without explicit unit evidence' };
    }
  }

  if (candidates.length === 0) {
    return { state: 'unresolved', reason: 'missing', details: 'no quantity field present' };
  }

  const units = new Set(candidates.map(c => c.unit));
  if (units.size > 1) {
    const nonzero = candidates.filter(c => c.value !== 0);
    const nonzeroUnits = new Set(nonzero.map(c => c.unit));
    if (nonzeroUnits.size > 1) {
      return {
        state: 'unresolved',
        reason: 'mixed',
        details: `mixed units: ${candidates.map(c => `${c.source}=${c.value}${c.unit}`).join(', ')}`,
      };
    }
    if (nonzeroUnits.size === 1) {
      const keep = nonzero[0];
      return packQty(keep.value, keep.unit, keep.source);
    }
    return { state: 'unresolved', reason: 'conflict', details: 'zero values in more than one unit; cannot choose' };
  }

  const unit = candidates[0].unit;
  const values = new Set(candidates.map(c => c.value));
  if (values.size > 1) {
    return {
      state: 'unresolved',
      reason: 'conflict',
      details: `conflicting ${unit} values: ${candidates.map(c => `${c.source}=${c.value}`).join(', ')}`,
    };
  }
  return packQty(candidates[0].value, unit, candidates[0].source);
}

export function quantityDisplay(q: QuantityResolution): string {
  if (q.state === 'unresolved') return `UNRESOLVED (${q.reason})`;
  const unit = q.unit === 'bbl' ? 'BBL' : 'ton';
  return `${q.value} ${unit}`;
}

export function quantityColumnHeader(unit: QuantityUnit | 'mixed' | 'unresolved'): string {
  if (unit === 'bbl') return 'BBLs';
  if (unit === 'ton') return 'Tons';
  if (unit === 'mixed') return 'Qty (mixed — not summed)';
  return 'Qty (unresolved)';
}

// ── Rate ─────────────────────────────────────────────────────────────────────

export interface FinancialRateEntry {
  jobType: string;
  method: 'per_bbl' | 'hourly';
  rate: number;
  frostRate?: number;
  frostRates?: Record<string, number>;
}

export type CompanyRateSheets = Record<string, FinancialRateEntry[]>;

/** Canonical aliases — Dashboard companySettings is the vocabulary source. */
export const CANONICAL_JOB_TYPE_ALIASES: Record<string, string> = {
  'Production %': 'Production Water',
  'Frac Water': 'Fresh Water',
  'Hot Shot': 'Fuel Service',
  'Flowback': 'Flowback Water',
  'Pit': 'Pit Water',
};

export function canonicalizeJobType(jobType: string, aliases: Record<string, string> = CANONICAL_JOB_TYPE_ALIASES): string {
  const trimmed = (jobType || '').trim();
  if (!trimmed) return '';
  if (aliases[trimmed]) return aliases[trimmed];
  const lower = trimmed.toLowerCase();
  for (const [from, to] of Object.entries(aliases)) {
    if (from.toLowerCase() === lower) return to;
  }
  return trimmed;
}

export type RateResolution =
  | { state: 'resolved'; entry: FinancialRateEntry; match: 'exact' | 'alias' }
  | { state: 'explicit_zero'; entry: FinancialRateEntry; match: 'exact' | 'alias' }
  | { state: 'unresolved'; reason: 'no_match' | 'empty' | 'ambiguous' | 'no_operator' | 'no_job_type'; details: string };

function packRate(entry: FinancialRateEntry, match: 'exact' | 'alias'): RateResolution {
  if (entry.rate === 0) return { state: 'explicit_zero', entry, match };
  return { state: 'resolved', entry, match };
}

export function resolveFinancialRate(
  rateSheets: CompanyRateSheets | null | undefined,
  operator: string,
  jobType: string,
  aliases: Record<string, string> = CANONICAL_JOB_TYPE_ALIASES,
): RateResolution {
  if (!rateSheets || Object.keys(rateSheets).length === 0) {
    return { state: 'unresolved', reason: 'empty', details: 'rate sheet configuration is empty' };
  }
  const op = (operator || '').trim();
  if (!op) return { state: 'unresolved', reason: 'no_operator', details: 'operator missing' };
  const jt = (jobType || '').trim();
  if (!jt) return { state: 'unresolved', reason: 'no_job_type', details: 'job type missing' };

  const exactOps = Object.keys(rateSheets).filter(k => k === op);
  const ciOps = Object.keys(rateSheets).filter(k => k.toLowerCase() === op.toLowerCase());
  let opKey: string | null = null;
  if (exactOps.length === 1) opKey = exactOps[0];
  else if (exactOps.length > 1) {
    return { state: 'unresolved', reason: 'ambiguous', details: `duplicate operator keys for ${op}` };
  } else if (ciOps.length === 1) opKey = ciOps[0];
  else if (ciOps.length > 1) {
    return { state: 'unresolved', reason: 'ambiguous', details: `ambiguous operator keys for ${op}` };
  } else {
    return { state: 'unresolved', reason: 'no_match', details: `no rate sheet for operator ${op}` };
  }

  const sheet = rateSheets[opKey] || [];
  if (!Array.isArray(sheet) || sheet.length === 0) {
    return { state: 'unresolved', reason: 'empty', details: `empty rate sheet for operator ${op}` };
  }

  const exact = sheet.filter(r => r.jobType === jt);
  if (exact.length === 1) return packRate(exact[0], 'exact');
  if (exact.length > 1) {
    return { state: 'unresolved', reason: 'ambiguous', details: `duplicate exact jobType ${jt}` };
  }

  const want = canonicalizeJobType(jt, aliases).toLowerCase();
  const aliased = sheet.filter(r => canonicalizeJobType(r.jobType, aliases).toLowerCase() === want);
  if (aliased.length === 1) return packRate(aliased[0], 'alias');
  if (aliased.length > 1) {
    return { state: 'unresolved', reason: 'ambiguous', details: `duplicate alias matches for ${jt}` };
  }
  return { state: 'unresolved', reason: 'no_match', details: `no rate for ${op} / ${jt}` };
}

// ── Split ────────────────────────────────────────────────────────────────────

export type SplitResolution =
  | { state: 'resolved'; split: number }
  | { state: 'explicit_zero'; split: 0 }
  | { state: 'unresolved'; reason: 'missing' | 'malformed'; details: string };

export function resolveEmployeeSplit(raw: unknown): SplitResolution {
  if (raw === undefined || raw === null) {
    return { state: 'unresolved', reason: 'missing', details: 'employee split not configured' };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { state: 'unresolved', reason: 'malformed', details: 'employee split is not a finite number' };
  }
  if (raw === 0) return { state: 'explicit_zero', split: 0 };
  return { state: 'resolved', split: raw };
}

// ── Time provenance ──────────────────────────────────────────────────────────

export type HoursProvenance = 'allocated' | 'observed' | 'legacy_unknown';

export interface TimeFacts {
  totalHours?: number | null;
  allocatedHours?: number | null;
  observedHours?: number | null;
  allocationMethod?: string | null;
  allocationVersion?: string | null;
}

export interface TimeResolution {
  observedHours: number | null;
  allocatedHours: number | null;
  financialHours: number | null;
  provenance: HoursProvenance;
  allocationMethod: string | null;
  allocationVersion: string | null;
  label: string;
}

export function resolveFinancialTime(facts: TimeFacts): TimeResolution {
  const observed = presentNumber(facts.observedHours) ? facts.observedHours : null;
  const allocated = presentNumber(facts.allocatedHours) ? facts.allocatedHours : null;
  const legacy = presentNumber(facts.totalHours) ? facts.totalHours : null;
  const method = facts.allocationMethod ? String(facts.allocationMethod) : null;
  const version = facts.allocationVersion ? String(facts.allocationVersion) : null;

  if (allocated !== null) {
    return {
      observedHours: observed,
      allocatedHours: allocated,
      financialHours: allocated,
      provenance: 'allocated',
      allocationMethod: method,
      allocationVersion: version,
      label: method ? `allocated (${method})` : 'allocated',
    };
  }
  if (observed !== null && legacy === null) {
    return {
      observedHours: observed,
      allocatedHours: null,
      financialHours: null,
      provenance: 'observed',
      allocationMethod: method,
      allocationVersion: version,
      label: 'observed (not allocated)',
    };
  }
  if (legacy !== null) {
    return {
      observedHours: observed,
      allocatedHours: null,
      financialHours: legacy,
      provenance: 'legacy_unknown',
      allocationMethod: method,
      allocationVersion: version,
      label: 'legacy/unknown provenance',
    };
  }
  return {
    observedHours: observed,
    allocatedHours: null,
    financialHours: null,
    provenance: 'legacy_unknown',
    allocationMethod: method,
    allocationVersion: version,
    label: 'no hours recorded',
  };
}

export function hoursColumnHeader(provenance: HoursProvenance): string {
  if (provenance === 'allocated') return 'Allocated hours';
  if (provenance === 'observed') return 'Observed hours';
  return 'Hours (legacy/unknown)';
}

/** Raw observed duration and allocated financial hours both appear when both exist. */
export function hoursDisplay(t: TimeResolution): string {
  const parts: string[] = [];
  if (t.allocatedHours != null) {
    parts.push(`${t.allocatedHours} ${t.allocationMethod ? `allocated (${t.allocationMethod})` : 'allocated'}`);
  }
  if (t.observedHours != null) {
    parts.push(`${t.observedHours} observed`);
  }
  if (parts.length === 0) {
    if (t.financialHours != null) return `${t.financialHours} (${t.label})`;
    return t.label;
  }
  return parts.join(' · ');
}

export function mixedQuantitySummary(bbls: number, tons: number): string {
  const parts: string[] = [];
  if (bbls) parts.push(`${bbls} BBL`);
  if (tons) parts.push(`${tons} ton`);
  return parts.length ? parts.join(' / ') : '0';
}

// ── Line projection ──────────────────────────────────────────────────────────

export interface InvoiceFinancialFacts {
  status?: unknown;
  operator?: string | null;
  jobType?: string | null;
  commodityType?: string | null;
  quantity: QuantityFacts;
  time: TimeFacts;
  rateSheets?: CompanyRateSheets | null;
  defaultSplit?: unknown;
}

export interface FinancialLineProjection {
  eligible: FinancialEligibility;
  quantity: QuantityResolution;
  rate: RateResolution;
  split: SplitResolution;
  time: TimeResolution;
  amountBilled: number | null;
  amountReason: string | null;
  employeeTake: number | null;
  qtyForBblColumn: number | null;
  qtyForTonColumn: number | null;
  hoursForMoney: number | null;
}

export function projectFinancialLine(facts: InvoiceFinancialFacts): FinancialLineProjection {
  const eligible = isFinanciallyEligibleStatus(facts.status);
  const quantity = resolveFinancialQuantity(facts.quantity);
  const jobType = (facts.commodityType || facts.jobType || '').trim();
  const rate = eligible.eligible
    ? resolveFinancialRate(facts.rateSheets, facts.operator || '', jobType)
    : { state: 'unresolved' as const, reason: 'no_match' as const, details: 'ineligible status; rate not applied' };
  const split = resolveEmployeeSplit(facts.defaultSplit);
  const time = resolveFinancialTime(facts.time);

  let amountBilled: number | null = null;
  let amountReason: string | null = null;
  const hoursForMoney: number | null = time.financialHours;

  if (!eligible.eligible) {
    amountReason = `ineligible:${eligible.reason}`;
  } else if (rate.state === 'unresolved') {
    amountReason = `rate:${rate.reason}`;
  } else if (rate.entry.method === 'hourly') {
    if (hoursForMoney === null) {
      amountReason = 'hours:missing';
    } else {
      amountBilled = Math.round(hoursForMoney * rate.entry.rate * 100) / 100;
    }
  } else if (rate.entry.method === 'per_bbl') {
    if (quantity.state === 'unresolved') {
      amountReason = `qty:${quantity.reason}`;
    } else if (quantity.unit !== 'bbl') {
      amountReason = 'qty:unsupported_unit_for_per_bbl';
      amountBilled = null;
    } else {
      amountBilled = Math.round(quantity.value * rate.entry.rate * 100) / 100;
    }
  }

  let employeeTake: number | null = null;
  if (amountBilled === null) {
    /* keep null */
  } else if (split.state === 'unresolved') {
    amountReason = amountReason || `split:${split.reason}`;
    employeeTake = null;
  } else {
    employeeTake = Math.round(amountBilled * split.split * 100) / 100;
  }

  return {
    eligible,
    quantity,
    rate,
    split,
    time,
    amountBilled,
    amountReason,
    employeeTake,
    qtyForBblColumn: quantity.state !== 'unresolved' && quantity.unit === 'bbl' ? quantity.value : null,
    qtyForTonColumn: quantity.state !== 'unresolved' && quantity.unit === 'ton' ? quantity.value : null,
    hoursForMoney,
  };
}

export function moneyDisplay(amount: number | null, reason: string | null): string {
  if (amount === null) return reason ? `UNRESOLVED (${reason})` : 'UNRESOLVED';
  return String(amount);
}
