/**
 * Governed well configuration for Current Job Review.
 * Catalog filtering is not authorization; scope is evaluated here.
 */
import { pickAllowlisted, WELL_CONFIG_ALLOWLIST } from '../dashboardCatalogProjection';
import {
  evaluateWbmWellScope,
  wellBelongsToDriverCompany,
  wellMatchesWbmScope,
} from './wbmWellScope';

export type GovernedWellRecord = {
  canonicalWellKey: string;
  displayName: string;
  apiNumber: string;
  h2sStatus: string;
  waterWeight: number | null;
  bblPerFoot: number | null;
  tanks: number | null;
  tankCapacity: number | null;
  tankHeight: number | null;
  route: string;
};

export type GovernedWellConfigDecision =
  | { ok: true; wells: Record<string, GovernedWellRecord>; wellCount: number }
  | { ok: false; reason: string };

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asWell(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

export function toGovernedWellRecord(
  wellName: string,
  well: Record<string, unknown>,
): GovernedWellRecord {
  const bounded = pickAllowlisted(well, WELL_CONFIG_ALLOWLIST);
  const tanks = finiteNumber(bounded.tanks) ?? finiteNumber(bounded.numTanks);
  const display = typeof bounded.ndicName === 'string' && bounded.ndicName.trim()
    ? bounded.ndicName.trim()
    : wellName;
  const api = typeof bounded.ndicApiNo === 'string' ? bounded.ndicApiNo.trim() : '';
  const h2s = typeof bounded.h2sStatus === 'string' && bounded.h2sStatus.trim()
    ? bounded.h2sStatus.trim()
    : 'unknown';
  const route = typeof bounded.route === 'string' ? bounded.route : '';
  const bblPerFoot = finiteNumber(bounded.bblPerFoot)
    ?? (tanks != null && tanks > 0 ? 20 * tanks : null);
  return {
    canonicalWellKey: wellName,
    displayName: display,
    apiNumber: api,
    h2sStatus: h2s,
    waterWeight: finiteNumber(bounded.waterWeight),
    bblPerFoot,
    tanks,
    tankCapacity: finiteNumber(bounded.tankCapacity),
    tankHeight: finiteNumber(bounded.tankHeight),
    route,
  };
}

export function evaluateGovernedWellConfig(input: {
  companyId: string;
  assignedRoutes: unknown;
  assignedWells: unknown;
  wellConfig: Record<string, unknown>;
  wellName?: string;
}): GovernedWellConfigDecision {
  const scope = evaluateWbmWellScope(input.assignedRoutes, input.assignedWells);
  if (!scope.ok) {
    return { ok: false, reason: scope.reason };
  }

  const requested = typeof input.wellName === 'string' ? input.wellName.trim() : '';
  if (requested) {
    const raw = input.wellConfig[requested];
    if (raw === undefined) {
      return { ok: false, reason: 'well_not_found' };
    }
    const well = asWell(raw);
    if (!wellBelongsToDriverCompany(well, input.companyId)) {
      return { ok: false, reason: 'well_not_found' };
    }
    if (!wellMatchesWbmScope(requested, well, scope)) {
      return { ok: false, reason: 'well_out_of_scope' };
    }
    const record = toGovernedWellRecord(requested, well);
    return { ok: true, wells: { [requested]: record }, wellCount: 1 };
  }

  const wells: Record<string, GovernedWellRecord> = {};
  for (const [wellName, raw] of Object.entries(input.wellConfig || {})) {
    const well = asWell(raw);
    if (!wellBelongsToDriverCompany(well, input.companyId)) continue;
    if (!wellMatchesWbmScope(wellName, well, scope)) continue;
    wells[wellName] = toGovernedWellRecord(wellName, well);
  }
  return { ok: true, wells, wellCount: Object.keys(wells).length };
}
