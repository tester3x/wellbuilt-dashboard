/**
 * Safety / Spill Incidents tenant isolation. Fail-closed:
 * missing or malformed company binding never grants a read.
 *
 * Drivers do not gain Dashboard access by submitting an incident.
 * External contacts never receive Dashboard access.
 * Platform admins (unscoped admin/it) may read any company.
 * Company staff only their own company.
 *
 * Capability checks stay in lib/auth (hasCapability). This module does not
 * import auth.ts so it remains node-testable without the Firebase auth graph.
 */

export const SAFETY_VIEW_CAPABILITY = 'viewSafety' as const;
export const SAFETY_MANAGE_CAPABILITY = 'manageSafety' as const;

export const SAFETY_CATEGORIES = [
  { id: 'spills', label: 'Spill Incidents', live: true },
  { id: 'accidents', label: 'Accidents', live: false },
  { id: 'injuries', label: 'Injuries', live: false },
  { id: 'equipment-damage', label: 'Equipment Damage', live: false },
  { id: 'near-misses', label: 'Near Misses', live: false },
  { id: 'dvir-defects', label: 'DVIR Defects', live: false },
  { id: 'corrective-actions', label: 'Corrective Actions', live: false },
] as const;

export type SafetyCategoryId = (typeof SAFETY_CATEGORIES)[number]['id'];

export interface SafetyUser {
  uid?: string;
  role?: string;
  roles?: string[];
  companyId?: string;
}

export type SafetyAccessDecision =
  | { ok: true; mode: 'platform' | 'tenant'; companyId: string | null }
  | { ok: false; reason: 'unauthenticated' | 'driver' | 'no_capability' | 'missing_company' | 'cross_company' };

function rolesOf(user: SafetyUser): string[] {
  if (Array.isArray(user.roles) && user.roles.length > 0) return user.roles.map(String);
  return user.role ? [String(user.role)] : [];
}

function isDriverOnly(user: SafetyUser): boolean {
  const roles = rolesOf(user);
  return roles.length > 0 && roles.every((r) => r === 'driver');
}

function isPlatformAdminUser(user: SafetyUser): boolean {
  if (user.companyId) return false;
  return rolesOf(user).some((r) => r === 'it' || r === 'admin');
}

export function decideSafetyAccess(
  user: SafetyUser | null | undefined,
  requestedCompanyId?: string | null,
  opts?: { canView?: boolean },
): SafetyAccessDecision {
  if (!user) return { ok: false, reason: 'unauthenticated' };
  if (isDriverOnly(user)) return { ok: false, reason: 'driver' };
  if (opts && opts.canView === false) return { ok: false, reason: 'no_capability' };

  if (isPlatformAdminUser(user)) {
    const cid = typeof requestedCompanyId === 'string' ? requestedCompanyId.trim() : '';
    return { ok: true, mode: 'platform', companyId: cid || null };
  }

  const bound = typeof user.companyId === 'string' ? user.companyId.trim() : '';
  if (!bound) return { ok: false, reason: 'missing_company' };

  const requested = typeof requestedCompanyId === 'string' ? requestedCompanyId.trim() : '';
  if (requested && requested !== bound) return { ok: false, reason: 'cross_company' };
  return { ok: true, mode: 'tenant', companyId: bound };
}

export function safetyCollectionPath(companyId: string): string {
  const cid = String(companyId || '').trim();
  if (!cid) throw new Error('missing_company');
  return `companies/${cid}/spill_incidents`;
}

export function safetyIncidentPath(companyId: string, incidentId: string): string {
  const id = String(incidentId || '').trim();
  if (!id) throw new Error('missing_incident');
  return `${safetyCollectionPath(companyId)}/${id}`;
}

export function safetyDeliveriesPath(companyId: string, incidentId: string): string {
  return `${safetyIncidentPath(companyId, incidentId)}/deliveries`;
}
