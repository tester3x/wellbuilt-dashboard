/**
 * Pure core for governed Fuel Prices mutations (save / scheduler / FSC math).
 *
 * Server-side FSC calculation ports the accepted client getFuelSurchargeRate
 * EXACTLY (src/lib/billing.ts) so the browser never supplies an FSC.
 * All helpers are pure and side-effect free.
 */

export type FscConfig = Record<string, unknown> | undefined | null;

const num = (v: unknown, dflt: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/**
 * Exact port of the accepted client getFuelSurchargeRate (src/lib/billing.ts).
 * Given the company FSC config + a diesel price, returns { rate, unit } or null.
 */
export function computeFscRate(
  config: FscConfig,
  currentDieselPrice: number | undefined
): { rate: number; unit: string } | null {
  const method =
    config && typeof (config as Record<string, unknown>).fuelSurchargeMethod === 'string'
      ? ((config as Record<string, unknown>).fuelSurchargeMethod as string)
      : undefined;
  if (!config || !method || method === 'none') return null;
  const c = config as Record<string, unknown>;
  const diesel = currentDieselPrice || 0;

  switch (method) {
    case 'hourly': {
      const baseline = num(c.fuelSurchargeBaseline, 0);
      const mpg = num(c.fuelSurchargeMPG, 6);
      const speed = num(c.fuelSurchargeSpeed, 30);
      if (diesel <= baseline) return { rate: 0, unit: '/hr' };
      return { rate: Math.round(((diesel - baseline) / mpg) * speed * 100) / 100, unit: '/hr' };
    }
    case 'per_mile': {
      const baseline = num(c.fuelSurchargeBaseline, 0);
      const mpg = num(c.fuelSurchargeMPG, 6);
      if (diesel <= baseline) return { rate: 0, unit: '/mi' };
      return { rate: Math.round(((diesel - baseline) / mpg) * 100) / 100, unit: '/mi' };
    }
    case 'flat_doe': {
      const baseline = num(c.fuelSurchargeBaseline, 3.25);
      const multiplier = num(c.fuelSurchargeMultiplier, 8);
      const step = num(c.fuelSurchargeStep, 0.1);
      const floor = typeof c.fuelSurchargeFloor === 'number' ? c.fuelSurchargeFloor : undefined;
      const ceiling = typeof c.fuelSurchargeCeiling === 'number' ? c.fuelSurchargeCeiling : undefined;
      const stepped = Math.floor(diesel / step) * step;
      const diff = stepped - baseline;
      if (diff <= 0) return { rate: floor || 0, unit: '/hr' };
      let perHour = Math.round(multiplier * diff * 100) / 100;
      if (floor !== undefined && perHour < floor) perHour = floor;
      if (ceiling !== undefined && perHour > ceiling) perHour = ceiling;
      return { rate: perHour, unit: '/hr' };
    }
    case 'percentage':
      return { rate: num(c.fuelSurchargePercent, 0) * 100, unit: '%' };
    case 'flat':
      return { rate: num(c.fuelSurchargeRate, 0), unit: '/load' };
    default:
      return null;
  }
}

/** Pick the company's DOE-based FSC config — mirrors the client historyFscConfig. */
export function pickCompanyFscConfig(
  company: Record<string, unknown> | null | undefined
): FscConfig {
  const bc =
    company && typeof company.billingConfig === 'object'
      ? (company.billingConfig as Record<string, Record<string, unknown>>)
      : null;
  if (!bc) return null;
  return (
    Object.values(bc).find(
      (c) =>
        c &&
        (c.fuelSurchargeMethod === 'flat_doe' ||
          c.fuelSurchargeMethod === 'hourly' ||
          c.fuelSurchargeMethod === 'per_mile')
    ) ?? null
  );
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a manual Save's bounded input. Server-side sanitization. */
export function validateManualPrice(input: {
  price?: unknown;
  date?: unknown;
  source?: unknown;
}):
  | { ok: true; price: number; date: string; source: string }
  | { ok: false; reason: string } {
  const price = typeof input.price === 'number' ? input.price : Number(input.price);
  if (!Number.isFinite(price) || price <= 0 || price > 100) {
    return { ok: false, reason: 'price_invalid' };
  }

  const date = typeof input.date === 'string' ? input.date.trim() : '';
  if (!YMD.test(date)) {
    return { ok: false, reason: 'date_invalid' };
  }
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) {
    return { ok: false, reason: 'date_invalid' };
  }

  // Sanity check calendar year: reject dates far in the past or future
  const [yearStr] = date.split('-');
  const year = parseInt(yearStr, 10);
  if (year < 2000 || year > 2100) {
    return { ok: false, reason: 'date_out_of_range' };
  }

  const rawSource = typeof input.source === 'string' ? input.source.trim() : '';
  const source = rawSource ? rawSource.slice(0, 64) : 'Manual';

  return {
    ok: true,
    price: Math.round(price * 1000) / 1000,
    date,
    source,
  };
}

export interface CallerAuthorizationProfile {
  uid: string;
  roles: string[];
  companyId?: string;
  caps: string[];
  isPlatformAdmin: boolean;
}

export type AuthzResult =
  | { ok: true }
  | { ok: false; code: 'unauthenticated' | 'permission-denied'; reason: string };

/**
 * Enforce authorization for saving diesel prices:
 * 1. Platform admin (isPlatformAdmin === true) is allowed for any targetCompanyId.
 * 2. Company-scoped caller must match targetCompanyId: caller.companyId === targetCompanyId.
 * 3. Caller must hold a manager role (manager, admin, it) OR billing capability (editBilling).
 */
export function authorizeDieselSaveCaller(
  caller: CallerAuthorizationProfile | null | undefined,
  targetCompanyId: string
): AuthzResult {
  if (!caller || !caller.uid) {
    return { ok: false, code: 'unauthenticated', reason: 'unauthenticated:Sign in required' };
  }

  if (!targetCompanyId || typeof targetCompanyId !== 'string') {
    return { ok: false, code: 'permission-denied', reason: 'target_company_required:Invalid target company' };
  }

  // Platform admin is authorized across all companies
  if (caller.isPlatformAdmin === true) {
    return { ok: true };
  }

  // Tenant scoping: non-platform-admins must match targetCompanyId
  if (!caller.companyId || caller.companyId !== targetCompanyId) {
    return {
      ok: false,
      code: 'permission-denied',
      reason: 'cross_company_denied:Caller is not authorized for this company',
    };
  }

  // Role or capability check: manager role OR editBilling capability
  const hasManagerRole = caller.roles.some((r) => r === 'manager' || r === 'admin' || r === 'it');
  const hasBillingCap = caller.caps.includes('editBilling');

  if (hasManagerRole || hasBillingCap) {
    return { ok: true };
  }

  return {
    ok: false,
    code: 'permission-denied',
    reason: 'insufficient_role_or_capability:Requires manager role or editBilling capability',
  };
}

export interface PriceRowLite {
  id: string;
  companyId?: string | null;
  date?: string | null;
  price?: unknown;
}

/**
 * Pure helper to plan the single price write and company current state update.
 */
export function planSinglePriceWrite(args: {
  targetCompanyId: string;
  date: string;
  price: number;
  currentPriceDate: string | null | undefined;
  fscConfig: FscConfig;
}): {
  isCurrent: boolean;
  fsc: { rate: number; unit: string } | null;
  deterministicDocId: string;
} {
  const fsc = computeFscRate(args.fscConfig, args.price);
  const currentPriceDate = args.currentPriceDate || '';
  // If no current price date exists or the new date is >= currentPriceDate, it updates current
  const isCurrent = !currentPriceDate || args.date >= currentPriceDate;
  const deterministicDocId = `${args.targetCompanyId}_${args.date}`;

  return {
    isCurrent,
    fsc,
    deterministicDocId,
  };
}
