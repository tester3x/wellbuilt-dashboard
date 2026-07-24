/**
 * Shared Payroll/Billing completed-job contract.
 *
 * Business invariant: PayrollEligible(J) == BillingEligible(J). Monetary
 * calculations differ downstream, but the canonical inclusion/exclusion
 * decision and the canonical service date live HERE and only here — the
 * previous independently-duplicated copies had already drifted (Billing
 * silently dropped operator-less jobs; Billing's rate date fell back to the
 * UTC calendar day of createdAt while Payroll used no fallback at all, so
 * undated offline-replay invoices priced and displayed inconsistently).
 *
 * Pure module: no Firebase imports — node-testable with
 * scripts/test-payroll-billing-contract.mjs.
 */

/** Default business timezone for civil-day math (Williston Basin ops). */
export const BUSINESS_TIMEZONE = 'America/Chicago';

/**
 * Billing groups operator-less completed jobs under this sentinel instead of
 * silently dropping them: a completed job that Payroll pays but Billing
 * cannot bill is an actionable data problem, not invisible revenue loss.
 */
export const MISSING_OPERATOR_LABEL = '⚠ Missing operator';

export interface TenantContext {
  /** Scoped customer-admin company. Undefined/empty = platform admin (global). */
  companyId?: string;
}

export interface EligibilityInput {
  status?: string | null;
  companyId?: string | null;
}

/**
 * THE canonical inclusion decision for both Payroll and Billing.
 *  - open / cancelled / void never qualify (cancel-orphans stay invisible).
 *  - A scoped tenant sees exactly its own companyId — unstamped legacy docs
 *    are excluded from every scoped tenant (platform admin still sees them).
 *  - Missing dates and missing operators NEVER exclude a completed job.
 */
export function isPayrollBillingEligible(
  d: EligibilityInput,
  tenant?: TenantContext,
): boolean {
  const status = d.status || 'open';
  if (status === 'open' || status === 'cancelled' || status === 'void') return false;
  const scope = tenant?.companyId || '';
  if (scope && (d.companyId || '') !== scope) return false;
  return true;
}

/** Normalize a stored date string to YYYY-MM-DD (invoice dates are MM/DD/YYYY,
 * diesel prices and rate seasons are YYYY-MM-DD). */
export function normalizeToYMD(dateStr: string): string {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);
  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  return dateStr;
}

export type ServiceDateSource = 'invoice_date' | 'created_at_fallback' | 'none';

export interface ServiceDateResult {
  /** Canonical YYYY-MM-DD (rate-effective + sort key). '' when unknown. */
  ymd: string;
  /** Display string (same as ymd; '' when unknown). */
  display: string;
  source: ServiceDateSource;
  /** True only for createdAt-derived legacy/recovery dates — mark these. */
  fallback: boolean;
}

interface TimestampLike {
  toDate?: () => Date;
}

function civilDayInTimezone(dt: Date, timeZone: string): string {
  try {
    // en-CA yields YYYY-MM-DD directly.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dt);
  } catch {
    return dt.toISOString().slice(0, 10);
  }
}

/**
 * THE canonical service date for both Payroll and Billing.
 *  1. The invoice's own `date` (the driver's local civil day, written at job
 *     birth / close) is authoritative — an offline replay never shifts it.
 *  2. Legacy/undated docs fall back to createdAt's civil day in the BUSINESS
 *     timezone (never the UTC day — an evening close must not bill on the
 *     next calendar day). Fallback results are explicitly marked.
 *  3. No evidence → explicit ''. A service date is never fabricated.
 */
export function invoiceServiceDate(
  d: { date?: string | null; createdAt?: TimestampLike | Date | string | null },
  businessTimezone: string = BUSINESS_TIMEZONE,
): ServiceDateResult {
  const stored = typeof d.date === 'string' ? normalizeToYMD(d.date) : '';
  if (stored) {
    return { ymd: stored, display: stored, source: 'invoice_date', fallback: false };
  }
  let created: Date | null = null;
  const raw = d.createdAt;
  if (raw instanceof Date) created = raw;
  else if (typeof raw === 'string') {
    const parsed = new Date(raw);
    created = isNaN(parsed.getTime()) ? null : parsed;
  } else if (raw && typeof (raw as TimestampLike).toDate === 'function') {
    try {
      const parsed = (raw as TimestampLike).toDate!();
      created = parsed instanceof Date && !isNaN(parsed.getTime()) ? parsed : null;
    } catch {
      created = null;
    }
  }
  if (created) {
    const ymd = civilDayInTimezone(created, businessTimezone);
    return { ymd, display: ymd, source: 'created_at_fallback', fallback: true };
  }
  return { ymd: '', display: '', source: 'none', fallback: false };
}
