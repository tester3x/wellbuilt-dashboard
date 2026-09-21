import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_ROLES,
} from './trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from './operational/staffWriteDispatch';
import { writeSecurityAudit } from './audit';
import {
  evaluateInviteEmployee,
  parseInviteEmployeeRequest,
} from './operational/inviteEmployee';

function throwFail(result: { ok: false; reason: string; field?: string }): never {
  const msg = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    result.reason === 'missing_company'
    || result.reason === 'cross_company'
    || result.reason === 'caller_authority_field'
    || result.reason === 'no_trusted_authority_record'
    || result.reason === 'missing_required_capability'
    || result.reason === 'trusted_authority_inactive'
    || result.reason === 'trusted_authority_malformed'
    || result.reason === 'trusted_authority_uid_mismatch'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  throw new httpsV2.HttpsError('invalid-argument', msg);
}

export const inviteEmployee = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const trusted = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_ROLES,
    );
    const access = staffWriteDispatchAccessFromTrusted(trusted);
    if (!access.ok) throwFail(access);
    const parsed = parseInviteEmployeeRequest(request.data);
    if (!parsed.ok) throwFail(parsed);

    const rtdb = admin.database();
    let driverCompanyId: string | null = null;
    let driverData: Record<string, unknown> | null = null;
    if (parsed.driverHash) {
      const dSnap = await rtdb.ref(`drivers/approved/${parsed.driverHash}`).once('value');
      if (!dSnap.exists()) {
        throw new httpsV2.HttpsError('not-found', 'driver_not_found');
      }
      driverData = (dSnap.val() || {}) as Record<string, unknown>;
      driverCompanyId = typeof driverData.companyId === 'string' ? driverData.companyId.trim() : null;
    }

    const authAdmin = admin.auth();
    let uid: string;
    let existed = false;
    try {
      const existing = await authAdmin.getUserByEmail(parsed.email);
      uid = existing.uid;
      existed = true;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== 'auth/user-not-found') throw err;
      const resolvedName = parsed.displayName
        || (typeof driverData?.legalName === 'string' ? driverData.legalName : '')
        || (typeof driverData?.displayName === 'string' ? driverData.displayName : '')
        || parsed.email.split('@')[0];
      const created = await authAdmin.createUser({
        email: parsed.email,
        emailVerified: false,
        displayName: resolvedName,
        disabled: false,
      });
      uid = created.uid;
    }

    const userSnap = await rtdb.ref(`users/${uid}`).once('value');
    const existingUser = userSnap.exists() ? (userSnap.val() as Record<string, unknown>) : null;
    const decided = evaluateInviteEmployee({
      actingCompanyId: access.companyId,
      existingUser,
      driverCompanyId,
    });
    if (!decided.ok) throwFail(decided);

    const resolvedDisplayName = parsed.displayName
      || (typeof existingUser?.displayName === 'string' ? existingUser.displayName : '')
      || (typeof driverData?.legalName === 'string' ? driverData.legalName : '')
      || parsed.email.split('@')[0];

    const userUpdate: Record<string, unknown> = {
      email: parsed.email,
      displayName: resolvedDisplayName,
      role: parsed.role,
      companyId: decided.companyId,
    };
    if (parsed.driverHash) userUpdate.driverHash = parsed.driverHash;
    await rtdb.ref(`users/${uid}`).update(userUpdate);

    if (parsed.driverHash) {
      await rtdb.ref(`drivers/approved/${parsed.driverHash}`).update({
        dashboardUid: uid,
        dashboardRole: parsed.role,
      });
    }

    let resetLink: string | null = null;
    try {
      resetLink = await authAdmin.generatePasswordResetLink(parsed.email);
    } catch (err) {
      console.warn('[inviteEmployee] reset link failed (non-fatal):', (err as Error)?.message);
    }

    await writeSecurityAudit({
      action: 'inviteEmployee',
      actorUid: access.uid,
      detail: { targetUid: uid, companyId: decided.companyId, existed, replay: decided.replay },
    });

    return {
      uid,
      email: parsed.email,
      role: parsed.role,
      displayName: resolvedDisplayName,
      existed,
      replay: decided.replay,
      resetLink,
      driverHash: parsed.driverHash,
      companyId: decided.companyId,
    };
  },
);
