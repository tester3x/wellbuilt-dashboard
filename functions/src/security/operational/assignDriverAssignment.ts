/**
 * Admin-authorized write of canonical assignment.
 *
 * While the legacy Drivers tab still lists drivers/approved/{hash}, a
 * dual-write is required. The returned RTDB patch is a single multi-path
 * update: either both canonical and legacy paths are included, or the
 * operation is refused. Partial success is impossible by construction.
 */
import { normalizeAssignmentField } from './canonicalAssignment';

export const CANONICAL_DRIVER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LEGACY_HASH_KEY_RE = /^[a-f0-9]{64}$/i;

export function isCanonicalDriverId(id: string): boolean {
  return CANONICAL_DRIVER_ID_RE.test((id || '').trim());
}

export function isLegacyHashKey(id: string): boolean {
  return LEGACY_HASH_KEY_RE.test((id || '').trim());
}

export function normalizeDisplayIdentity(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export type AssignmentProfileView = {
  exists: boolean;
  driverId?: string;
  active?: boolean;
  companyId?: string | null;
  displayName?: string | null;
  assignedRoutes?: unknown;
  assignedWells?: unknown;
};

export type AssignmentLegacyView = {
  exists: boolean;
  key?: string;
  active?: boolean;
  companyId?: string | null;
  displayName?: string | null;
};

export type AssignDriverAssignmentInput = {
  callerUid: string;
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
  driverId?: string;
  legacyKey?: string;
  assignedRoutes: unknown;
  /** Omit to leave canonical assignedWells unchanged. Pass [] to clear. */
  assignedWells?: unknown;
  wellsSpecified?: boolean;
  profile: AssignmentProfileView;
  legacyRow: AssignmentLegacyView;
  now?: number;
};

export type AssignDriverAssignmentSuccess = {
  ok: true;
  driverId: string;
  dualWrite: boolean;
  routes: string[];
  wells?: string[];
  wellsUpdated: boolean;
  patch: Record<string, unknown>;
};

export type AssignDriverAssignmentFailure = {
  ok: false;
  reason: string;
};

export type AssignDriverAssignmentResult =
  | AssignDriverAssignmentSuccess
  | AssignDriverAssignmentFailure;

function identitiesMatch(
  a: { displayName?: string | null; companyId?: string | null },
  b: { displayName?: string | null; companyId?: string | null },
): boolean {
  const an = normalizeDisplayIdentity(a.displayName || '');
  const bn = normalizeDisplayIdentity(b.displayName || '');
  if (!an || !bn || an !== bn) return false;
  const ac = (a.companyId || '').trim();
  const bc = (b.companyId || '').trim();
  return !!ac && !!bc && ac === bc;
}

export function evaluateAssignDriverAssignment(
  input: AssignDriverAssignmentInput,
): AssignDriverAssignmentResult {
  const driverId = (input.driverId || '').trim();
  const legacyKey = (input.legacyKey || '').trim();

  if (!driverId && !legacyKey) {
    return { ok: false, reason: 'driver_identity_required' };
  }
  if (driverId && !isCanonicalDriverId(driverId)) {
    return { ok: false, reason: 'not_canonical_driver_id' };
  }
  if (legacyKey && !isLegacyHashKey(legacyKey)) {
    return { ok: false, reason: 'not_legacy_key' };
  }

  const routesNorm = normalizeAssignmentField(input.assignedRoutes);
  if (!Array.isArray(input.assignedRoutes)) {
    return { ok: false, reason: 'assigned_routes_must_be_array' };
  }

  let wellsUpdated = false;
  let wells: string[] | undefined;
  if (input.wellsSpecified === true) {
    if (!Array.isArray(input.assignedWells)) {
      return { ok: false, reason: 'assigned_wells_must_be_array' };
    }
    wells = normalizeAssignmentField(input.assignedWells).values;
    wellsUpdated = true;
  }

  if (!input.profile.exists || !input.profile.driverId) {
    return { ok: false, reason: 'unknown_driver' };
  }
  if (driverId && input.profile.driverId !== driverId) {
    return { ok: false, reason: 'profile_id_mismatch' };
  }
  if (input.profile.active === false) {
    return { ok: false, reason: 'inactive_driver' };
  }
  const profileCompany = (input.profile.companyId || '').trim();
  if (!profileCompany) {
    return { ok: false, reason: 'profile_company_required' };
  }
  if (!input.isPlatformAdmin) {
    const callerCompany = (input.callerCompanyId || '').trim();
    if (!callerCompany || callerCompany !== profileCompany) {
      return { ok: false, reason: 'cross_company' };
    }
  }

  const dualWrite = !!legacyKey;
  if (dualWrite) {
    if (!input.legacyRow.exists) {
      return { ok: false, reason: 'legacy_row_missing' };
    }
    if (input.legacyRow.active === false) {
      return { ok: false, reason: 'legacy_inactive' };
    }
    if (
      !identitiesMatch(
        {
          displayName: input.profile.displayName,
          companyId: input.profile.companyId,
        },
        {
          displayName: input.legacyRow.displayName,
          companyId: input.legacyRow.companyId,
        },
      )
    ) {
      return { ok: false, reason: 'legacy_canonical_identity_mismatch' };
    }
  }

  const now = input.now ?? Date.now();
  const canonicalId = input.profile.driverId;
  const patch: Record<string, unknown> = {
    [`drivers/profiles/${canonicalId}/assignedRoutes`]: routesNorm.values,
    [`drivers/profiles/${canonicalId}/assignedAt`]: now,
    [`drivers/profiles/${canonicalId}/assignedBy`]: input.callerUid,
  };
  if (wellsUpdated) {
    patch[`drivers/profiles/${canonicalId}/assignedWells`] = wells;
  }
  if (dualWrite) {
    patch[`drivers/approved/${legacyKey}/assignedRoutes`] = routesNorm.values;
    if (wellsUpdated) {
      patch[`drivers/approved/${legacyKey}/assignedWells`] = wells;
    }
    patch[`drivers/approved/${legacyKey}/assignedAt`] = now;
  }

  if (dualWrite) {
    const canonicalPaths = Object.keys(patch).filter((p) => p.startsWith('drivers/profiles/'));
    const legacyPaths = Object.keys(patch).filter((p) => p.startsWith('drivers/approved/'));
    if (canonicalPaths.length === 0 || legacyPaths.length === 0) {
      return { ok: false, reason: 'partial_write_refused' };
    }
  }

  return {
    ok: true,
    driverId: canonicalId,
    dualWrite,
    routes: routesNorm.values,
    wells,
    wellsUpdated,
    patch,
  };
}
