import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireManageDrivers } from './adminAuth';
import {
  evaluateStaffWriteProject,
  pickProjectFields,
  type ProjectWriteOp,
} from './operational/staffWriteProject';

const ALLOWED_KEYS = new Set(['op', 'projectId', 'record']);

export const staffWriteProject = httpsV2.onCall(
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
    const op = raw.op as ProjectWriteOp;
    if (op !== 'create' && op !== 'update') {
      throw new httpsV2.HttpsError('invalid-argument', 'op must be create or update');
    }
    const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
    const record = (raw.record && typeof raw.record === 'object' && !Array.isArray(raw.record))
      ? (raw.record as Record<string, unknown>)
      : {};
    const fs = admin.firestore();

    if (op === 'create') {
      const decided = evaluateStaffWriteProject({
        op, existing: null, record, callerCompanyId: caller.companyId, isPlatformAdmin: caller.isPlatformAdmin,
      });
      if (!decided.ok) throw new httpsV2.HttpsError('failed-precondition', decided.reason);
      const fields = pickProjectFields(record);
      const ref = await fs.collection('projects').add({
        ...fields,
        companyId: decided.companyId,
        status: typeof fields.status === 'string' ? fields.status : 'active',
        createdAt: FieldValue.serverTimestamp(),
        createdBy: fields.createdBy || caller.uid,
      });
      return { ok: true as const, op, projectId: ref.id };
    }

    if (!projectId) throw new httpsV2.HttpsError('invalid-argument', 'projectId required');
    const outcome = await fs.runTransaction(async (tx) => {
      const ref = fs.collection('projects').doc(projectId);
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      const decided = evaluateStaffWriteProject({
        op, existing, record, callerCompanyId: caller.companyId, isPlatformAdmin: caller.isPlatformAdmin,
      });
      if (!decided.ok) throw new httpsV2.HttpsError('failed-precondition', decided.reason);
      const fields = pickProjectFields(record);
      tx.update(ref, { ...fields, updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid });
      return { projectId };
    });
    return { ok: true as const, op, ...outcome };
  },
);
