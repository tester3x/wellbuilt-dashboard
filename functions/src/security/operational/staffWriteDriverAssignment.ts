/**
 * Canonical WB-M route/well writes. Exact driverId only.
 * No display-name matching. No legacy mirroring.
 */
export const CANONICAL_DRIVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssignmentDecision =
  | { ok: true; driverId: string; companyId: string }
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
  return { ok: true, driverId: input.driverId, companyId };
}
