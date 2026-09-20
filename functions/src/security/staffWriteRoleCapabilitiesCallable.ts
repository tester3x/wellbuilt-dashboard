import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_ROLES,
} from './trustedStaffAuthority';
import { writeSecurityAudit } from './audit';
import {
  runStaffWriteRoleCapabilities,
  type RoleEditorStoreTx,
} from './operational/staffWriteRoleCapabilities';

function throwFail(result: { ok: false; reason: string; field?: string }): never {
  const msg = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    result.reason === 'missing_company'
    || result.reason === 'unprivileged_staff'
    || result.reason === 'missing_required_capability'
    || result.reason === 'no_trusted_authority_record'
    || result.reason === 'trusted_authority_inactive'
    || result.reason === 'trusted_authority_malformed'
    || result.reason === 'trusted_authority_uid_mismatch'
    || result.reason === 'reserved_capability'
    || result.reason === 'unknown_capability'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  if (result.reason === 'company_not_found') {
    throw new httpsV2.HttpsError('not-found', msg);
  }
  throw new httpsV2.HttpsError('invalid-argument', msg);
}

export const staffWriteRoleCapabilities = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const authority = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_ROLES,
    );
    const fs = admin.firestore();
    const outcome = await fs.runTransaction(async (tx) => {
      const store: RoleEditorStoreTx = {
        async getCompany(companyId: string) {
          const snap = await tx.get(fs.collection('companies').doc(companyId));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        updateCompany(companyId: string, data: Record<string, unknown>) {
          tx.update(fs.collection('companies').doc(companyId), data);
        },
      };
      return runStaffWriteRoleCapabilities({
        authority,
        request: request.data,
        store,
      });
    });
    if (!outcome.ok) throwFail(outcome);
    await writeSecurityAudit({
      action: 'staffWriteRoleCapabilities',
      actorUid: authority.uid,
      detail: { companyId: outcome.companyId },
    });
    return {
      ok: true as const,
      companyId: outcome.companyId,
      roleLabels: outcome.roleLabels,
      roleCapabilities: outcome.roleCapabilities,
    };
  },
);
