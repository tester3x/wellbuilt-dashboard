/**
 * Canonical WB-M bootstrap snapshot. Eligibility and well catalog come from
 * the same server-side profile read — never a client RTDB parent get.
 */
import { assignmentDigest } from './assignmentScope';
import { evaluateWbmWellScope, projectWbmWells } from './wbmWellScope';

export type WbmEligibilityStatus = 'eligible' | 'ineligible' | 'unknown';

export type WbmBootstrapSnapshot = {
  ok: true;
  driverId: string;
  companyId: string;
  active: true;
  assignedRoutes: string[] | null;
  assignedWells: string[] | null;
  assignmentRevision: number;
  assignmentDigest: string;
  eligibilityStatus: WbmEligibilityStatus;
  eligibilityReason: string;
  wells: Record<string, Record<string, unknown>>;
  wellCount: number;
};

export function revisionOf(profile: Record<string, unknown>): number {
  const n = Number(profile.assignmentRevision);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function stringListOrEmpty(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

export function buildWbmBootstrapSnapshot(input: {
  driverId: string;
  companyId: string;
  profile: Record<string, unknown>;
  wellConfig: Record<string, unknown>;
}): WbmBootstrapSnapshot {
  const scope = evaluateWbmWellScope(input.profile.assignedRoutes, input.profile.assignedWells);

  let eligibilityStatus: WbmEligibilityStatus;
  let eligibilityReason: string;
  let assignedRoutes: string[] | null;
  let assignedWells: string[] | null;

  if (scope.ok) {
    eligibilityStatus = 'eligible';
    eligibilityReason = 'scope_ok';
    assignedRoutes = scope.routes;
    assignedWells = scope.wells;
  } else if (scope.reason === 'scope_missing' || scope.reason === 'scope_malformed') {
    eligibilityStatus = 'unknown';
    eligibilityReason = scope.reason;
    assignedRoutes = null;
    assignedWells = null;
  } else {
    eligibilityStatus = 'ineligible';
    eligibilityReason = scope.reason;
    assignedRoutes = stringListOrEmpty(input.profile.assignedRoutes);
    assignedWells = stringListOrEmpty(input.profile.assignedWells);
  }

  const wells = scope.ok
    ? projectWbmWells(input.wellConfig, input.companyId, scope)
    : {};

  return {
    ok: true,
    driverId: input.driverId,
    companyId: input.companyId,
    active: true,
    assignedRoutes,
    assignedWells,
    assignmentRevision: revisionOf(input.profile),
    assignmentDigest: assignmentDigest(input.profile.assignedRoutes, input.profile.assignedWells),
    eligibilityStatus,
    eligibilityReason,
    wells,
    wellCount: Object.keys(wells).length,
  };
}
