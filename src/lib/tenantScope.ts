// Shared tenant-scoping helper for dashboard operational data.
//
// Customer/company admins (user.companyId set) are LOCKED to their own company.
// WB platform admins (no companyId) may view globally, or scope to a selected
// company via the company picker. Operational fetches use `scope.companyId` to
// add a Firestore `where('companyId','==',...)` and MUST exclude docs whose
// companyId doesn't match when scoped (missing companyId never appears in a
// scoped customer view).
import { WellBuiltUser, isWbPlatformAdmin } from './auth';

export interface TenantScope {
  /** Company to scope operational data to. `null` means no single-company scope. */
  companyId: string | null;
  /** True only for a platform admin viewing everything (no company filter). */
  isGlobal: boolean;
  /** True if the user is a WB platform admin (no companyId + elevated role). */
  isPlatformAdmin: boolean;
  /** True if the user is a customer admin locked to their own company. */
  isCustomerScoped: boolean;
}

/**
 * Resolve the tenant scope for an operational-data fetch.
 *
 * - Customer admin (`user.companyId` set) → locked to `user.companyId`.
 * - Platform admin (no companyId) → `selectedCompanyId` scopes if set, else global.
 * - Unassigned non-admin → no scope and not global (callers should render empty).
 */
export function resolveTenantScope(
  user: WellBuiltUser | null,
  selectedCompanyId?: string | null,
): TenantScope {
  const platform = isWbPlatformAdmin(user);

  if (user?.companyId) {
    return { companyId: user.companyId, isGlobal: false, isPlatformAdmin: platform, isCustomerScoped: true };
  }
  if (platform) {
    return selectedCompanyId
      ? { companyId: selectedCompanyId, isGlobal: false, isPlatformAdmin: true, isCustomerScoped: false }
      : { companyId: null, isGlobal: true, isPlatformAdmin: true, isCustomerScoped: false };
  }
  return { companyId: null, isGlobal: false, isPlatformAdmin: false, isCustomerScoped: false };
}

/** Whether a fetch is allowed to run at all (scoped to a company OR global admin). */
export function scopeAllowsFetch(scope: TenantScope): boolean {
  return !!scope.companyId || scope.isGlobal;
}

/** Consistent telemetry line for scoped fetches. */
export function logTenantScope(page: string, scope: TenantScope, extra?: Record<string, unknown>): void {
  console.log('[tenant-scope]', JSON.stringify({
    page,
    companyId: scope.companyId,
    isGlobal: scope.isGlobal,
    ...extra,
  }));
}
