import { HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

export type AdminRole = 'admin' | 'it';

export interface AdminIdentity {
  uid: string;
  role: AdminRole;
  email?: string;
  companyId?: string;
}

/**
 * Server-side role check for truth-debug / RAG-export endpoints.
 *
 * Reads RTDB `users/{uid}/role` — the same path the dashboard frontend uses.
 * Throws an HttpsError the callable SDK surfaces to the caller on failure.
 * Does NOT invent a new auth system. Does NOT bypass anything.
 *
 * Behaviour:
 * - no auth context (unauthenticated call) -> unauthenticated
 * - authenticated but users/{uid} missing -> permission-denied
 * - role is not 'admin' or 'it' -> permission-denied
 */
export async function requireAdminRole(
  request: CallableRequest<unknown>
): Promise<AdminIdentity> {
  const auth = request.auth;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = auth.uid;
  const snap = await admin.database().ref(`users/${uid}`).once('value');
  if (!snap.exists()) {
    throw new HttpsError('permission-denied', 'User record not found.');
  }
  const data = snap.val() as {
    role?: string;
    email?: string;
    companyId?: string;
  };
  const role = data.role;
  if (role !== 'admin' && role !== 'it') {
    throw new HttpsError('permission-denied', 'Admin role required.');
  }
  const out: AdminIdentity = { uid, role };
  if (typeof data.email === 'string') out.email = data.email;
  if (typeof data.companyId === 'string') out.companyId = data.companyId;
  return out;
}
