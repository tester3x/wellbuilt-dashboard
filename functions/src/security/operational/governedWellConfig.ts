/**
 * Governed well configuration for Current Job Review.
 * Catalog filtering is not authorization; scope is evaluated here.
 *
 * WB-T client contract (governedConfigClient / governedConfigCore):
 *   request allowlist: { wellName, assignmentKey }
 *   reply: { ok, found, config, reason }
 * config is the allowlisted well_config record for ONE well. Never a wells
 * map. Never a hardcoded 20×tanks bbl-per-foot. Numeric strings pass through.
 */
import { pickAllowlisted, WELL_CONFIG_ALLOWLIST } from '../dashboardCatalogProjection';
import {
  evaluateWbmWellScope,
  wellBelongsToDriverCompany,
  wellMatchesWbmScope,
} from './wbmWellScope';

export const GOVERNED_WELL_CONFIG_REQUEST_ALLOWLIST = ['wellName', 'assignmentKey'] as const;

/** WB-T GovernedWellConfig-compatible record for one assigned well. */
export type GovernedWellConfig = {
  wellName: string;
  [k: string]: unknown;
};

export type GovernedWellConfigRequest =
  | { ok: true; wellName: string; assignmentKey: string | null }
  | { ok: false; reason: string };

export type GovernedWellConfigDecision =
  | { ok: true; found: true; config: GovernedWellConfig; reason: null }
  | { ok: true; found: false; config: null; reason: string }
  | { ok: false; found: false; config: null; reason: string };

function asWell(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

/**
 * Project one well_config row for WB-T. Stored numeric representation is
 * preserved (including numeric strings). bblPerFoot is never invented from
 * 20×tanks — the client derives from stored rate or tankCapacity/height.
 */
export function toGovernedWellConfig(
  wellName: string,
  well: Record<string, unknown>,
): GovernedWellConfig {
  const bounded = pickAllowlisted(well, WELL_CONFIG_ALLOWLIST);
  return { wellName, ...bounded };
}

/** @deprecated Use toGovernedWellConfig. Kept as an alias for existing imports. */
export function toGovernedWellRecord(
  wellName: string,
  well: Record<string, unknown>,
): GovernedWellConfig {
  return toGovernedWellConfig(wellName, well);
}

export function evaluateGovernedWellConfigRequest(data: unknown): GovernedWellConfigRequest {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'request_required' };
  }
  const req = data as Record<string, unknown>;
  const allowed = new Set<string>(GOVERNED_WELL_CONFIG_REQUEST_ALLOWLIST);
  for (const key of Object.keys(req)) {
    if (!allowed.has(key)) return { ok: false, reason: 'unexpected_field' };
  }

  if (typeof req.wellName !== 'string') return { ok: false, reason: 'missing_wellName' };
  const wellName = req.wellName.trim();
  if (!wellName || wellName.length > 120) return { ok: false, reason: 'invalid_wellName' };

  let assignmentKey: string | null = null;
  if (req.assignmentKey !== undefined && req.assignmentKey !== null) {
    if (typeof req.assignmentKey !== 'string') return { ok: false, reason: 'invalid_assignmentKey' };
    const trimmed = req.assignmentKey.trim();
    if (trimmed.length > 128) return { ok: false, reason: 'invalid_assignmentKey' };
    assignmentKey = trimmed.length > 0 ? trimmed : null;
  }

  return { ok: true, wellName, assignmentKey };
}

export function evaluateGovernedWellConfig(input: {
  companyId: string;
  assignedRoutes: unknown;
  assignedWells: unknown;
  wellConfig: Record<string, unknown>;
  wellName: string;
  assignmentKey?: string | null;
}): GovernedWellConfigDecision {
  const requested = typeof input.wellName === 'string' ? input.wellName.trim() : '';
  if (!requested) {
    return { ok: false, found: false, config: null, reason: 'missing_wellName' };
  }

  const scope = evaluateWbmWellScope(input.assignedRoutes, input.assignedWells);
  if (!scope.ok) {
    return { ok: false, found: false, config: null, reason: scope.reason };
  }

  const raw = input.wellConfig[requested];
  if (raw === undefined) {
    return { ok: true, found: false, config: null, reason: 'well_not_found' };
  }
  const well = asWell(raw);
  if (!wellBelongsToDriverCompany(well, input.companyId)) {
    return { ok: true, found: false, config: null, reason: 'well_not_found' };
  }
  if (!wellMatchesWbmScope(requested, well, scope)) {
    return { ok: true, found: false, config: null, reason: 'well_out_of_scope' };
  }

  return {
    ok: true,
    found: true,
    config: toGovernedWellConfig(requested, well),
    reason: null,
  };
}
