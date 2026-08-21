/**
 * Canonical WB-M assignment validation. Invalid input is refused — never
 * coerced into an empty scope. No legacy mirroring.
 */
import { wellBelongsToDriverCompany } from './wbmWellScope';

export const MAX_SCOPE_ITEMS = 200;

export function assignmentDigest(routes: unknown, wells: unknown): string {
  return JSON.stringify({
    r: Array.isArray(routes) ? routes : null,
    w: Array.isArray(wells) ? wells : null,
  });
}

export function previewContextDigest(input: {
  driverId: string;
  companyId: string;
  assignmentRevision: number;
  currentRoutes: unknown;
  currentWells: unknown;
  proposedRoutes: string[];
  proposedWells: string[];
}): string {
  return JSON.stringify({
    driverId: input.driverId,
    companyId: input.companyId,
    assignmentRevision: input.assignmentRevision,
    current: assignmentDigest(input.currentRoutes, input.currentWells),
    proposed: assignmentDigest(input.proposedRoutes, input.proposedWells),
  });
}

export function revisionNumber(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function parseScopeList(
  raw: unknown,
  field: 'assignedRoutes' | 'assignedWells',
): { ok: true; values: string[] } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: false, reason: `${field}_required` };
  if (raw === null) return { ok: false, reason: `${field}_required` };
  if (!Array.isArray(raw)) return { ok: false, reason: `${field}_malformed` };
  if (raw.length > MAX_SCOPE_ITEMS) return { ok: false, reason: `${field}_too_long` };
  const values: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, reason: `${field}_non_string` };
    const v = item.trim();
    if (!v) return { ok: false, reason: `${field}_blank` };
    if (seen.has(v)) return { ok: false, reason: `${field}_duplicate` };
    seen.add(v);
    values.push(v);
  }
  return { ok: true, values };
}

export function knownRouteNames(wellConfig: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const raw of Object.values(wellConfig || {})) {
    const well = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    if (typeof well.route === 'string' && well.route.trim()) names.add(well.route.trim());
  }
  return names;
}

export function validateAssignedRoutesAgainstCatalog(
  routes: string[],
  knownRoutes: Set<string>,
): { ok: true } | { ok: false; reason: string } {
  for (const route of routes) {
    if (route === 'Unrouted' || route.startsWith('Unrouted')) continue;
    if (!knownRoutes.has(route)) return { ok: false, reason: 'nonexistent_route' };
  }
  return { ok: true };
}

export function validateAssignedWellsAgainstCatalog(
  wells: string[],
  wellConfig: Record<string, unknown>,
  driverCompanyId: string,
): { ok: true } | { ok: false; reason: string } {
  for (const wellName of wells) {
    const raw = wellConfig[wellName];
    if (raw === undefined) return { ok: false, reason: 'nonexistent_well' };
    const well = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    if (!wellBelongsToDriverCompany(well, driverCompanyId)) {
      return { ok: false, reason: 'cross_company_well' };
    }
  }
  return { ok: true };
}

export type AssignmentApplyDecision =
  | { ok: true; nextRevision: number }
  | { ok: false; reason: string };

export function evaluateAssignmentTransaction(input: {
  driverId: string;
  profile: Record<string, unknown> | null;
  expectedPreviewContextDigest: string;
  proposedRoutes: string[];
  proposedWells: string[];
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
}): AssignmentApplyDecision {
  if (!input.profile) return { ok: false, reason: 'profile_missing' };
  if (input.profile.active === false) return { ok: false, reason: 'profile_inactive' };
  const companyId = typeof input.profile.companyId === 'string' ? input.profile.companyId.trim() : '';
  if (!companyId) return { ok: false, reason: 'profile_unscoped' };
  if (!input.isPlatformAdmin) {
    if (!input.callerCompanyId || input.callerCompanyId !== companyId) {
      return { ok: false, reason: 'tenant_mismatch' };
    }
  }
  const live = previewContextDigest({
    driverId: input.driverId,
    companyId,
    assignmentRevision: revisionNumber(input.profile.assignmentRevision),
    currentRoutes: input.profile.assignedRoutes,
    currentWells: input.profile.assignedWells,
    proposedRoutes: input.proposedRoutes,
    proposedWells: input.proposedWells,
  });
  if (live !== input.expectedPreviewContextDigest) {
    return { ok: false, reason: 'stale_preview_context' };
  }
  const rev = revisionNumber(input.profile.assignmentRevision);
  return { ok: true, nextRevision: rev + 1 };
}
