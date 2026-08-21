/**
 * Admin-governed NEW canonical WB-M driver. Never searches legacy rows
 * by display name. Existing consistent tester accounts are KEEP_CANONICAL
 * and must be repaired via staffWriteDriverAssignment, not recreated.
 */
export const CANONICAL_DRIVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProvisionDecision =
  | { ok: true; scopeState: 'configured' | 'scope_not_configured' }
  | { ok: false; reason: string };

export function evaluateCanonicalProvision(input: {
  displayName: unknown;
  companyId: unknown;
  nameIndexOwner: string | null;
  assignedRoutes?: unknown;
  assignedWells?: unknown;
}): ProvisionDecision {
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!displayName) return { ok: false, reason: 'display_name_required' };
  const companyId = typeof input.companyId === 'string' ? input.companyId.trim() : '';
  if (!companyId) return { ok: false, reason: 'company_required' };
  if (input.nameIndexOwner) return { ok: false, reason: 'name_taken' };

  const routesPresent = input.assignedRoutes !== undefined;
  const wellsPresent = input.assignedWells !== undefined;
  if (!routesPresent && !wellsPresent) {
    return { ok: true, scopeState: 'scope_not_configured' };
  }
  return { ok: true, scopeState: 'configured' };
}
