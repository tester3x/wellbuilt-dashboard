import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { authorizeAdminCall } from '../admin/authority';
import { OUTSIDE_DRIVER_ACCESS_COLLECTION } from './operational/outsideDriverAccess';

const COMPANY_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Platform-admin-only explicit opt-in for the outside contractor delivery lane.
 * This flag lives outside client-editable company settings and is NOT a subscription tier.
 */
export const adminSetOutsideDriverAccess = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const uid = request.auth?.uid;
    const db = admin.firestore();
    const actorSnap = uid ? await db.collection('platform_admins').doc(uid).get() : null;
    const authority = authorizeAdminCall(
      request.auth ? { uid: request.auth.uid, token: request.auth.token as Record<string, unknown> } : null,
      actorSnap?.exists ? actorSnap.data() : null,
    );
    if (!authority.ok) throw new httpsV2.HttpsError('permission-denied', authority.reason);
    const input = request.data as Record<string, unknown> | null;
    if (!input || Array.isArray(input) || typeof input !== 'object'
      || Object.keys(input).some(k => !['companyId', 'enabled'].includes(k))
      || typeof input.companyId !== 'string' || !COMPANY_RE.test(input.companyId)
      || typeof input.enabled !== 'boolean') {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_outside_driver_configuration');
    }
    const companyId = input.companyId;
    const company = await db.collection('companies').doc(companyId).get();
    if (!company.exists) throw new httpsV2.HttpsError('not-found', 'company_not_found');
    await db.collection(OUTSIDE_DRIVER_ACCESS_COLLECTION).doc(companyId).set({
      schemaVersion: 1,
      mode: 'temporary_contractors',
      enabled: input.enabled,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: authority.actorUid,
    });
    return { ok: true, companyId, enabled: input.enabled, mode: 'temporary_contractors' };
  },
);
