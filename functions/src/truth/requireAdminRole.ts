import { HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { requireAdminAuthority } from '../security/adminAuth';
import { staffHasCapability } from '../security/canonicalAdminAuthority';

export type AdminRole = 'admin' | 'it';

export interface AdminIdentity {
  uid: string;
  role: AdminRole;
  email?: string;
  companyId?: string;
  isPlatformAdmin: boolean;
}

/**
 * Canonical admin gate for truth endpoints.
 * Company staff cannot supply another companyId.
 */
export async function requireAdminRole(
  request: CallableRequest<unknown>
): Promise<AdminIdentity> {
  const auth = request.auth;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const authority = await requireAdminAuthority(
    auth.uid,
    auth.token as Record<string, unknown> | undefined,
  );
  if (!staffHasCapability(authority, 'viewTruthDebug')) {
    throw new HttpsError('permission-denied', 'missing_viewTruthDebug');
  }
  return {
    uid: authority.uid,
    role: authority.class === 'platform' ? 'admin' : 'it',
    isPlatformAdmin: authority.class === 'platform',
    companyId: authority.companyId || undefined,
  };
}

export function scopedCompanyId(
  identity: AdminIdentity,
  requested?: string,
): string | undefined {
  if (identity.isPlatformAdmin) return requested || identity.companyId;
  if (requested && identity.companyId && requested !== identity.companyId) {
    throw new HttpsError('permission-denied', 'cross_tenant');
  }
  if (!identity.companyId) {
    throw new HttpsError('permission-denied', 'unscoped_target');
  }
  return identity.companyId;
}
