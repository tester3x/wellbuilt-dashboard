import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireManageDrivers } from './adminAuth';
import {
  DISPATCH_CREATE_ALLOWLIST,
  DISPATCH_UPDATE_ALLOWLIST,
  evaluateStaffWriteDispatch,
  pickDispatchFields,
  type StaffWriteOp,
} from './operational/staffWriteDispatch';

const ALLOWED_KEYS = new Set(['op', 'dispatchId', 'record']);

export const staffWriteDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const op = raw.op as StaffWriteOp;
    if (op !== 'create' && op !== 'update' && op !== 'cancel') {
      throw new httpsV2.HttpsError('invalid-argument', 'op must be create, update, or cancel');
    }
    const dispatchId = typeof raw.dispatchId === 'string' ? raw.dispatchId.trim() : '';
    const record = (raw.record && typeof raw.record === 'object' && !Array.isArray(raw.record))
      ? (raw.record as Record<string, unknown>)
      : {};

    const fs = admin.firestore();
    let job: Record<string, unknown> | null = null;
    if (op !== 'create') {
      if (!dispatchId) throw new httpsV2.HttpsError('invalid-argument', 'dispatchId required');
      const snap = await fs.collection('dispatches').doc(dispatchId).get();
      job = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    }
    const decided = evaluateStaffWriteDispatch({
      op,
      job,
      record,
      callerCompanyId: caller.companyId,
      isPlatformAdmin: caller.isPlatformAdmin,
    });
    if (!decided.ok) throw new httpsV2.HttpsError('failed-precondition', decided.reason);

    if (op === 'create') {
      const fields = pickDispatchFields(record, DISPATCH_CREATE_ALLOWLIST);
      const docRef = await fs.collection('dispatches').add({
        ...fields,
        companyId: decided.companyId,
        status: typeof fields.status === 'string' ? fields.status : 'pending',
        assignedAt: FieldValue.serverTimestamp(),
        assignedBy: fields.assignedBy || caller.uid,
      });
      return { ok: true as const, op, dispatchId: docRef.id };
    }
    if (op === 'cancel') {
      await fs.collection('dispatches').doc(dispatchId).update({
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledBy: caller.uid,
      });
      return { ok: true as const, op, dispatchId };
    }
    const fields = pickDispatchFields(record, DISPATCH_UPDATE_ALLOWLIST);
    delete fields.companyId;
    delete fields.status;
    if (typeof record.status === 'string' && record.status !== 'dismissed') {
      fields.status = record.status;
    }
    await fs.collection('dispatches').doc(dispatchId).update({
      ...fields,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: caller.uid,
    });
    return { ok: true as const, op, dispatchId };
  },
);
