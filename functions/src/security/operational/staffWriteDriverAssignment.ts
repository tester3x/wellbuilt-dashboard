/**
 * Canonical WB-M route authority writes. Exact driverId only.
 * No display-name matching. Legacy mirror only when migratedToDriverId
 * on an approved row equals this driverId.
 */
export const CANONICAL_DRIVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssignmentDecision =
  | { ok: true; driverId: string; companyId: string; mirrorLegacyKey: string | null }
  | { ok: false; reason: string };

export function assertCanonicalDriverId(raw: unknown): string {
  if (typeof raw !== 'string' || !CANONICAL_DRIVER_ID.test(raw.trim())) {
    throw new Error('driver_id_malformed');
  }
  return raw.trim();
}

export function evaluateStaffWriteDriverAssignment(input: {
  driverId: string;
  profile: Record<string, unknown> | null;
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
  mirrorLegacy: boolean;
  approvedRows: Array<{ key: string; migratedToDriverId?: unknown; displayName?: unknown }>;
  expectedAssignedRoutes?: unknown;
}): AssignmentDecision {
  if (!input.profile) return { ok: false, reason: 'profile_missing' };
  if (input.profile.active === false) return { ok: false, reason: 'profile_inactive' };
  const companyId = typeof input.profile.companyId === 'string' ? input.profile.companyId.trim() : '';
  if (!companyId) return { ok: false, reason: 'profile_unscoped' };
  if (!input.isPlatformAdmin) {
    if (!input.callerCompanyId || input.callerCompanyId !== companyId) {
      return { ok: false, reason: 'tenant_mismatch' };
    }
  }
  if (input.expectedAssignedRoutes !== undefined) {
    const current = JSON.stringify(input.profile.assignedRoutes ?? null);
    const expected = JSON.stringify(input.expectedAssignedRoutes ?? null);
    if (current !== expected) return { ok: false, reason: 'concurrency_conflict' };
  }

  const linked = input.approvedRows.filter((row) => row.migratedToDriverId === input.driverId);
  if (linked.length > 1) return { ok: false, reason: 'ambiguous_legacy_link' };
  if (input.mirrorLegacy && linked.length !== 1) {
    return { ok: false, reason: 'legacy_link_unproven' };
  }
  return {
    ok: true,
    driverId: input.driverId,
    companyId,
    mirrorLegacyKey: input.mirrorLegacy && linked.length === 1 ? linked[0].key : null,
  };
}
