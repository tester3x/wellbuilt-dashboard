/**
 * Fail-closed auth gate for previously public HTTPS/callables (16g P0-6).
 * Unauthenticated callers are refused. Legacy driverHash is never authority.
 */
import * as httpsV2 from 'firebase-functions/v2/https';

export function requireCallableAuth(request: httpsV2.CallableRequest): { uid: string } {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new httpsV2.HttpsError('unauthenticated', 'auth_required_16g');
  }
  const data = (request.data || {}) as { driverHash?: unknown };
  if (data.driverHash != null) {
    throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
  }
  return { uid };
}

export function requireHttpBearer(req: { headers?: Record<string, unknown> }): void {
  const raw = req.headers?.authorization || req.headers?.Authorization;
  const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] || '') : '';
  if (!header.toLowerCase().startsWith('bearer ') || header.slice(7).trim().length < 16) {
    const err = new Error('auth_required_16g');
    (err as { status?: number }).status = 401;
    throw err;
  }
}
