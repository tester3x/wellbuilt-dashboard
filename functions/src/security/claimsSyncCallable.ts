/**
 * Dual-gated claims sync callable. Source-only; not invoked against
 * production in this task.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requirePlatformAdmin } from './adminAuth';
import { claimsSyncAuditRecord, decideClaimsSync, type ClaimsSyncMode } from './claimsSync';
import { writeSecurityAudit } from './audit';

export const adminSyncStaffClaims = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const authority = await requirePlatformAdmin(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const data = (request.data || {}) as {
      uid?: string;
      mode?: ClaimsSyncMode;
      expectedCompanyId?: string | null;
      expectedRole?: string | null;
    };
    const uid = String(data.uid || '').trim();
    const mode: ClaimsSyncMode = data.mode === 'execute' ? 'execute' : 'dry_run';
    if (!uid) throw new httpsV2.HttpsError('invalid-argument', 'uid_required');

    const [staffSnap, platSnap, userRec] = await Promise.all([
      admin.firestore().collection('staff').doc(uid).get(),
      admin.firestore().collection('platform_admins').doc(uid).get(),
      admin.auth().getUser(uid),
    ]);
    const staff = staffSnap.exists ? staffSnap.data() || {} : {};
    const decided = decideClaimsSync({
      callerIsPlatform: authority.class === 'platform',
      mode,
      target: {
        uid,
        expectedCompanyId: data.expectedCompanyId ?? null,
        expectedRole: data.expectedRole ?? null,
      },
      snapshot: {
        staffEnabled: staff.enabled === true,
        staffCompanyId: typeof staff.companyId === 'string' ? staff.companyId : null,
        staffRole: typeof staff.role === 'string' ? staff.role : null,
        platformAdminEnabled: platSnap.exists && platSnap.get('enabled') === true,
        existingClaims: (userRec.customClaims || {}) as Record<string, unknown>,
      },
    });
    if (!decided.ok) throw new httpsV2.HttpsError('failed-precondition', decided.reason);

    if (decided.wouldWrite) {
      await admin.auth().setCustomUserClaims(uid, decided.nextClaims);
    }
    await writeSecurityAudit({
      action: 'adminSyncStaffClaims',
      actorUid: authority.uid,
      detail: claimsSyncAuditRecord(decided),
    });
    return {
      ok: true,
      mode,
      uid,
      changedKeys: decided.changedKeys,
      wouldWrite: decided.wouldWrite,
      requiresTokenRefresh: true,
      nextClaims: decided.nextClaims,
    };
  },
);
