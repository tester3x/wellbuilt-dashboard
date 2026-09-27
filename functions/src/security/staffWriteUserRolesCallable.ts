import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_ROLES,
} from './trustedStaffAuthority';
import { writeSecurityAudit } from './audit';
import {
  runStaffWriteUserRoles,
  type UserRolesStore,
} from './operational/staffWriteUserRoles';

function throwFail(result: { ok: false; reason: string; field?: string }): never {
  const msg = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    result.reason === 'missing_company'
    || result.reason === 'cross_company'
    || result.reason === 'self_grant_forbidden'
    || result.reason === 'no_trusted_authority_record'
    || result.reason === 'missing_required_capability'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  if (result.reason === 'user_not_found') {
    throw new httpsV2.HttpsError('not-found', msg);
  }
  throw new httpsV2.HttpsError('invalid-argument', msg);
}

export const staffWriteUserRoles = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const authority = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_ROLES,
    );
    const rtdb = admin.database();
    const store: UserRolesStore = {
      async getUser(uid: string) {
        const snap = await rtdb.ref(`users/${uid}`).once('value');
        return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
      },
      async updateUser(uid: string, fields: Record<string, unknown>) {
        await rtdb.ref(`users/${uid}`).update(fields);
      },
    };
    const outcome = await runStaffWriteUserRoles({
      authority,
      request: request.data,
      store,
    });
    if (!outcome.ok) throwFail(outcome);
    await writeSecurityAudit({
      action: 'staffWriteUserRoles',
      actorUid: authority.uid,
      detail: { targetUid: outcome.targetUid, companyId: outcome.companyId },
    });
    return {
      ok: true as const,
      targetUid: outcome.targetUid,
      companyId: outcome.companyId,
      roles: outcome.roles,
      role: outcome.role,
    };
  },
);
