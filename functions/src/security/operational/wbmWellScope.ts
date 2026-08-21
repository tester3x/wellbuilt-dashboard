/**
 * WB-M well-scope evaluation. Routes/wells here are Dashboard Routes
 * selections that bound which wells a driver may see in WB-M — not WB-T
 * dispatch jobs.
 */
import { LEGACY_WELL_POOL_COMPANY_ID, WELL_CONFIG_ALLOWLIST, pickAllowlisted } from '../dashboardCatalogProjection';

export type WbmScopeReason =
  | 'scope_ok'
  | 'scope_missing'
  | 'scope_malformed'
  | 'scope_empty'
  | 'scope_unrouted_only';

export type WbmScope =
  | { ok: true; reason: 'scope_ok'; routes: string[]; wells: string[] }
  | { ok: false; reason: Exclude<WbmScopeReason, 'scope_ok'> };

export function isRealRouteName(route: string): boolean {
  return !!route && !route.startsWith('Unrouted');
}

function asStringArray(raw: unknown): { present: boolean; malformed: boolean; values: string[] } {
  if (raw === undefined || raw === null) return { present: false, malformed: false, values: [] };
  if (!Array.isArray(raw)) return { present: true, malformed: true, values: [] };
  const values = raw
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
  return { present: true, malformed: false, values };
}

export function evaluateWbmWellScope(assignedRoutes: unknown, assignedWells: unknown): WbmScope {
  const routes = asStringArray(assignedRoutes);
  const wells = asStringArray(assignedWells);
  if (routes.malformed || wells.malformed) return { ok: false, reason: 'scope_malformed' };
  if (!routes.present && !wells.present) return { ok: false, reason: 'scope_missing' };
  const routeList = routes.present ? routes.values : [];
  const wellList = wells.present ? wells.values : [];
  if (routeList.length === 0 && wellList.length === 0) return { ok: false, reason: 'scope_empty' };
  const hasRealRoute = routeList.some(isRealRouteName);
  if (!hasRealRoute && wellList.length === 0) return { ok: false, reason: 'scope_unrouted_only' };
  return { ok: true, reason: 'scope_ok', routes: routeList, wells: wellList };
}

export function wellBelongsToDriverCompany(
  well: Record<string, unknown>,
  driverCompanyId: string,
): boolean {
  const wc = typeof well.companyId === 'string' ? well.companyId.trim() : '';
  if (wc) return wc === driverCompanyId;
  return driverCompanyId === LEGACY_WELL_POOL_COMPANY_ID;
}

export function wellMatchesWbmScope(
  wellName: string,
  well: Record<string, unknown>,
  scope: Extract<WbmScope, { ok: true }>,
): boolean {
  if (scope.wells.includes(wellName)) return true;
  const wellRoute = typeof well.route === 'string' ? well.route : '';
  return scope.routes.some((assigned) => {
    if (assigned === 'Unrouted') return wellRoute.startsWith('Unrouted');
    return assigned === wellRoute;
  });
}

export function projectWbmWells(
  wellConfig: Record<string, unknown>,
  driverCompanyId: string,
  scope: Extract<WbmScope, { ok: true }>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [wellName, raw] of Object.entries(wellConfig || {})) {
    const well = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    if (!wellBelongsToDriverCompany(well, driverCompanyId)) continue;
    if (!wellMatchesWbmScope(wellName, well, scope)) continue;
    out[wellName] = pickAllowlisted(well, WELL_CONFIG_ALLOWLIST);
  }
  return out;
}
