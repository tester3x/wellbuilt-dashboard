/**
 * Firestore-side staff / platform-admin decision.
 * Mirrors firestore.rules. token.role is never consulted.
 */
export type StaffRole = 'admin' | 'it' | 'manager' | 'dispatch';

export function decideFirestoreStaffAccess(input: {
  wellbuiltAdmin?: boolean;
  platformAdminEnabled?: boolean;
  staff?: { enabled?: boolean; role?: string; companyId?: string } | null;
  resourceCompanyId?: string;
  kind?: string;
}): { ok: true; via: 'platform_admin' | 'company_staff' } | { ok: false; reason: string } {
  if (input.wellbuiltAdmin === true) {
    if (input.platformAdminEnabled === true) return { ok: true, via: 'platform_admin' };
    return { ok: false, reason: 'platform_admin_revoked' };
  }
  const s = input.staff;
  if (!s || s.enabled !== true) return { ok: false, reason: 'staff_disabled' };
  if (!['admin', 'it', 'manager', 'dispatch'].includes(s.role || '')) {
    return { ok: false, reason: 'staff_role' };
  }
  if (!s.companyId || !input.resourceCompanyId || s.companyId !== input.resourceCompanyId) {
    return { ok: false, reason: 'staff_company' };
  }
  return { ok: true, via: 'company_staff' };
}

export function decideOwnerScopedRead(input: {
  callerDriverId?: string;
  callerCompanyId?: string;
  resourceDriverId?: unknown;
  resourceCompanyId?: unknown;
}): { ok: boolean; reason?: string } {
  if (typeof input.resourceCompanyId !== 'string' || !input.resourceCompanyId) {
    return { ok: false, reason: 'unscoped' };
  }
  if (input.callerCompanyId !== input.resourceCompanyId) return { ok: false, reason: 'cross_company' };
  if (typeof input.resourceDriverId !== 'string' || !input.resourceDriverId) {
    return { ok: false, reason: 'missing_owner' };
  }
  if (input.callerDriverId !== input.resourceDriverId) return { ok: false, reason: 'not_owner' };
  return { ok: true };
}

export function decideStorageObjectAccess(input: {
  callerDriverId: string;
  callerCompanyId: string;
  pathCompanyId: string;
  pathDriverId: string;
  contentType?: string;
  bytes?: number;
  maxBytes?: number;
  op: 'read' | 'write' | 'delete';
}): { ok: boolean; reason?: string } {
  if (input.pathCompanyId !== input.callerCompanyId) return { ok: false, reason: 'cross_company' };
  if (input.pathDriverId !== input.callerDriverId) return { ok: false, reason: 'not_owner' };
  if (input.op === 'delete') return { ok: false, reason: 'delete_denied' };
  if (input.op === 'write') {
    if (input.contentType && !input.contentType.startsWith('image/') && input.contentType !== 'application/pdf') {
      return { ok: false, reason: 'content_type' };
    }
    if (typeof input.bytes === 'number' && typeof input.maxBytes === 'number' && input.bytes >= input.maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
  }
  return { ok: true };
}
