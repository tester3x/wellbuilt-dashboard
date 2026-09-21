import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from './operational/staffWriteDispatch';
import { writeSecurityAudit } from './audit';
import {
  parseStaffWriteDriverRoster,
  runStaffWriteDriverRoster,
  type RosterStore,
} from './operational/staffWriteDriverRoster';

function throwFail(result: { ok: false; reason: string; field?: string }): never {
  const msg = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    result.reason === 'missing_company'
    || result.reason === 'cross_company'
    || result.reason === 'caller_authority_field'
    || result.reason === 'missing_required_capability'
    || result.reason === 'no_trusted_authority_record'
    || result.reason === 'trusted_authority_inactive'
    || result.reason === 'trusted_authority_malformed'
    || result.reason === 'trusted_authority_uid_mismatch'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  if (result.reason === 'not_found') {
    throw new httpsV2.HttpsError('not-found', msg);
  }
  throw new httpsV2.HttpsError('invalid-argument', msg);
}

export const staffWriteDriverRoster = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const trusted = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    const access = staffWriteDispatchAccessFromTrusted(trusted);
    if (!access.ok) throwFail(access);
    const parsed = parseStaffWriteDriverRoster(request.data);
    if (!parsed.ok) throwFail(parsed);
    const rtdb = admin.database();
    const store: RosterStore = {
      async getApproved(path) {
        const snap = await rtdb.ref(`drivers/approved/${path}`).once('value');
        return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
      },
      async getPending(key) {
        const snap = await rtdb.ref(`drivers/pending/${key}`).once('value');
        return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
      },
      async updateApproved(path, fields) {
        await rtdb.ref(`drivers/approved/${path}`).update(fields);
      },
      async setApproved(path, fields) {
        await rtdb.ref(`drivers/approved/${path}`).set(fields);
      },
      async removeApproved(path) {
        await rtdb.ref(`drivers/approved/${path}`).remove();
      },
      async updatePending(key, fields) {
        await rtdb.ref(`drivers/pending/${key}`).update(fields);
      },
    };
    const outcome = await runStaffWriteDriverRoster({
      actingCompanyId: access.companyId,
      actorUid: access.uid,
      request: parsed,
      store,
    });
    if (!outcome.ok) throwFail(outcome);
    await writeSecurityAudit({
      action: 'staffWriteDriverRoster',
      actorUid: access.uid,
      detail: { op: outcome.op, path: outcome.path, companyId: access.companyId },
    });
    return { ok: true as const, op: outcome.op, path: outcome.path, companyId: access.companyId };
  },
);
