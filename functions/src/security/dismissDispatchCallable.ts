import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from './operational/staffWriteDispatch';
import { parseDispatchId } from './operational/dispatchPacketPin';
import {
  evaluateDismissDispatch,
  type DispatchDismissView,
} from './operational/dismissDispatch';

const ALLOWED_KEYS = new Set(['dispatchId']);
const FORBIDDEN_KEYS = Object.freeze([
  'companyId',
  'targetCompanyId',
  'uid',
  'role',
  'roles',
  'capabilities',
  'manageDrivers',
  'isPlatformAdmin',
  'wellbuiltAdmin',
  'platformAdmin',
] as const);

function viewFromSnap(id: string, data: Record<string, unknown> | undefined): DispatchDismissView {
  const d = data || {};
  return { id, status: d.status, companyId: d.companyId, splitGroupId: d.splitGroupId };
}

function throwDecided(decided: { ok: false; reason: string; field?: string }): never {
  const msg = decided.field ? `${decided.reason}:${decided.field}` : decided.reason;
  if (decided.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    decided.reason === 'missing_company'
    || decided.reason === 'missing_required_capability'
    || decided.reason === 'no_trusted_authority_record'
    || decided.reason === 'trusted_authority_inactive'
    || decided.reason === 'trusted_authority_malformed'
    || decided.reason === 'trusted_authority_uid_mismatch'
    || decided.reason === 'cross_company'
    || decided.reason === 'caller_authority_field'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  const code = decided.reason === 'malformed_dispatch_id' || decided.reason === 'dispatch_id_required'
    ? 'invalid-argument'
    : 'failed-precondition';
  throw new httpsV2.HttpsError(code, msg);
}

export const dismissDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const trusted = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    const access = staffWriteDispatchAccessFromTrusted(trusted);
    if (!access.ok) throwDecided(access);
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
        throwDecided({ ok: false, reason: 'caller_authority_field', field: key });
      }
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const parsed = parseDispatchId(raw.dispatchId);
    if (!parsed.ok) throwDecided(parsed);

    const fs = admin.firestore();
    const outcome = await fs.runTransaction(async (tx) => {
      const jobRef = fs.collection('dispatches').doc(parsed.dispatchId);
      const snap = await tx.get(jobRef);
      const job = snap.exists ? viewFromSnap(parsed.dispatchId, snap.data() as Record<string, unknown>) : null;
      let siblings: DispatchDismissView[] = [];
      const splitGroupId = job && typeof job.splitGroupId === 'string' ? job.splitGroupId.trim() : '';
      if (splitGroupId) {
        const sibSnap = await tx.get(
          fs.collection('dispatches').where('splitGroupId', '==', splitGroupId),
        );
        siblings = sibSnap.docs.map((d) => viewFromSnap(d.id, d.data() as Record<string, unknown>));
      }
      const decided = evaluateDismissDispatch({
        job,
        siblings,
        callerCompanyId: access.companyId,
        isPlatformAdmin: access.isPlatformAdmin,
      });
      if (!decided.ok) {
        throw new httpsV2.HttpsError('failed-precondition', decided.reason);
      }
      if (!decided.idempotent) {
        for (const id of decided.dispatchIds) {
          tx.update(fs.collection('dispatches').doc(id), {
            status: 'dismissed',
            dismissedAt: FieldValue.serverTimestamp(),
            dismissedBy: access.uid,
          });
        }
      }
      return { idempotent: decided.idempotent, dispatchIds: decided.dispatchIds };
    });

    return { ok: true as const, ...outcome };
  },
);
