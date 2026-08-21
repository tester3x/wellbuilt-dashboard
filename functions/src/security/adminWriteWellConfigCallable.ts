import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import {
  evaluateAdminWriteWellConfig,
  pickWellConfigFields,
  type WellConfigOp,
} from './operational/adminWriteWellConfig';

const ALLOWED_KEYS = new Set(['op', 'wellName', 'newName', 'record']);

export const adminWriteWellConfig = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB', enforceAppCheck: false },
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
    const op = raw.op as WellConfigOp;
    if (!['add', 'update', 'rename', 'setRoute', 'deleteConfig'].includes(op)) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid op');
    }
    const wellName = typeof raw.wellName === 'string' ? raw.wellName.trim() : '';
    const newName = typeof raw.newName === 'string' ? raw.newName.trim() : '';
    const record = (raw.record && typeof raw.record === 'object' && !Array.isArray(raw.record))
      ? (raw.record as Record<string, unknown>)
      : {};

    const rtdb = admin.database();
    const treeSnap = await rtdb.ref('well_config').once('value');
    const existingNames = treeSnap.exists() ? Object.keys(treeSnap.val() as Record<string, unknown>) : [];
    const decided = evaluateAdminWriteWellConfig({
      op, wellName, newName, record, existingNames, caller,
    });
    if (!decided.ok) throw new httpsV2.HttpsError('failed-precondition', decided.reason);

    if (op === 'add') {
      await rtdb.ref(`well_config/${decided.wellName}`).set(pickWellConfigFields(record));
      return { ok: true as const, op, wellName: decided.wellName };
    }
    if (op === 'update') {
      await rtdb.ref(`well_config/${decided.wellName}`).update(pickWellConfigFields(record));
      return { ok: true as const, op, wellName: decided.wellName };
    }
    if (op === 'setRoute') {
      const route = typeof record.route === 'string' ? record.route.trim() : 'Unrouted';
      const updates: Record<string, string> = {};
      for (const name of decided.wellNames || [decided.wellName]) {
        updates[`well_config/${name}/route`] = route;
      }
      await rtdb.ref().update(updates);
      return { ok: true as const, op, wellName: decided.wellName, wellNames: decided.wellNames };
    }
    if (op === 'rename' && decided.newName && decided.newName !== decided.wellName) {
      const current = treeSnap.child(decided.wellName).val() || {};
      const perfSnap = await rtdb.ref(`performance/${decided.wellName}`).once('value');
      const updates: Record<string, unknown> = {
        [`well_config/${decided.newName}`]: current,
        [`well_config/${decided.wellName}`]: null,
      };
      if (perfSnap.exists()) {
        updates[`performance/${decided.newName}`] = perfSnap.val();
        updates[`performance/${decided.wellName}`] = null;
      }
      await rtdb.ref().update(updates);
      return { ok: true as const, op, wellName: decided.wellName, newName: decided.newName };
    }
    if (op === 'deleteConfig') {
      // Config node only. Packets/history are preserved unless a later
      // dedicated purge callable is authorized.
      await rtdb.ref(`well_config/${decided.wellName}`).remove();
      return { ok: true as const, op, wellName: decided.wellName };
    }
    return { ok: true as const, op, wellName: decided.wellName };
  },
);
