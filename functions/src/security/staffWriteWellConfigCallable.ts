/**
 * Staff create/update/rename/delete for RTDB well_config.
 * Client identity writes are denied. GPS route/routeRecording/routeGroupWell
 * children remain the only client-writable well_config fields.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { writeSecurityAudit } from './audit';
import {
  evaluateStaffWriteWellConfig,
  findDuplicateApiWell,
  findWellNameKey,
} from './operational/staffWriteWellConfig';

const ALLOWED = new Set(['op', 'wellName', 'config']);

async function rewritePacketWellName(
  rtdb: admin.database.Database,
  collection: 'packets/processed' | 'packets/outgoing',
  oldName: string,
  newName: string | null,
): Promise<void> {
  const snap = await rtdb.ref(collection).orderByChild('wellName').equalTo(oldName).once('value');
  if (!snap.exists()) return;
  const updates: Record<string, unknown> = {};
  snap.forEach((child) => {
    const key = child.key;
    if (!key) return;
    if (newName === null) updates[`${collection}/${key}`] = null;
    else updates[`${collection}/${key}/wellName`] = newName;
  });
  if (Object.keys(updates).length) await rtdb.ref().update(updates);
}

export const staffWriteWellConfig = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    if (raw.op !== 'create' && raw.op !== 'update' && raw.op !== 'delete' && raw.op !== 'rename') {
      throw new httpsV2.HttpsError('invalid-argument', 'op must be create, update, delete, or rename');
    }
    const op = raw.op as 'create' | 'update' | 'delete' | 'rename';
    const wellName = typeof raw.wellName === 'string' ? raw.wellName.trim() : '';
    const config = raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)
      ? (raw.config as Record<string, unknown>)
      : {};

    const rtdb = admin.database();
    const allSnap = await rtdb.ref('well_config').once('value');
    const all = (allSnap.exists() ? allSnap.val() : {}) as Record<string, unknown>;
    const existingNameKey = findWellNameKey(all, wellName);
    const existingByName = existingNameKey
      ? ((all[existingNameKey] as Record<string, unknown>) || null)
      : null;
    const requestedApi = typeof config.ndicApiNo === 'string' ? config.ndicApiNo : '';
    const duplicateApiWell = op === 'create' ? findDuplicateApiWell(all, requestedApi, wellName) : null;

    const decided = evaluateStaffWriteWellConfig({
      op,
      wellName,
      config,
      existingByName,
      existingNameKey,
      duplicateApiWell,
      callerCompanyId: caller.companyId,
      isPlatformAdmin: false,
    });

    if (!decided.ok) {
      const code = decided.reason === 'pool_forbidden' ? 'permission-denied'
        : decided.reason === 'name_taken' || decided.reason === 'duplicate_api' ? 'already-exists'
        : decided.reason === 'not_found' ? 'not-found'
        : 'invalid-argument';
      throw new httpsV2.HttpsError(code, `${decided.reason}:${decided.message}`);
    }

    if (decided.action === 'already_exact') {
      await writeSecurityAudit({
        action: 'staffWriteWellConfig',
        actorUid: caller.uid,
        detail: { op, wellName: decided.wellName, idempotent: true },
      });
      return {
        ok: true as const,
        wellName: decided.wellName,
        created: false,
        updated: false,
        idempotent: true,
        config: decided.payload,
      };
    }

    if (decided.action === 'delete') {
      await rewritePacketWellName(rtdb, 'packets/processed', decided.wellName, null);
      await rewritePacketWellName(rtdb, 'packets/outgoing', decided.wellName, null);
      await rtdb.ref(`performance/${decided.wellName}`).remove();
      await rtdb.ref(`well_config/${decided.wellName}`).remove();
      await writeSecurityAudit({
        action: 'staffWriteWellConfig',
        actorUid: caller.uid,
        detail: { op: 'delete', wellName: decided.wellName },
      });
      return {
        ok: true as const,
        wellName: decided.wellName,
        created: false,
        updated: false,
        deleted: true,
        idempotent: false,
      };
    }

    if (decided.action === 'rename') {
      const taken = findWellNameKey(all, decided.newName);
      if (taken && taken !== decided.wellName) {
        throw new httpsV2.HttpsError('already-exists', `name_taken:Well already exists as "${taken}"`);
      }
      const next = { ...decided.payload };
      await rtdb.ref(`well_config/${decided.newName}`).set(next);
      await rewritePacketWellName(rtdb, 'packets/processed', decided.wellName, decided.newName);
      await rewritePacketWellName(rtdb, 'packets/outgoing', decided.wellName, decided.newName);
      const perf = await rtdb.ref(`performance/${decided.wellName}`).once('value');
      if (perf.exists()) {
        await rtdb.ref(`performance/${decided.newName}`).set(perf.val());
        await rtdb.ref(`performance/${decided.wellName}`).remove();
      }
      await rtdb.ref(`well_config/${decided.wellName}`).remove();
      await writeSecurityAudit({
        action: 'staffWriteWellConfig',
        actorUid: caller.uid,
        detail: { op: 'rename', wellName: decided.wellName, newName: decided.newName },
      });
      return {
        ok: true as const,
        wellName: decided.newName,
        previousName: decided.wellName,
        created: false,
        updated: true,
        renamed: true,
        idempotent: false,
        config: next,
      };
    }

    if (decided.action === 'update') {
      await rtdb.ref(`well_config/${decided.wellName}`).update(decided.patch);
      await writeSecurityAudit({
        action: 'staffWriteWellConfig',
        actorUid: caller.uid,
        detail: { op: 'update', wellName: decided.wellName, updated: true },
      });
      return {
        ok: true as const,
        wellName: decided.wellName,
        created: false,
        updated: true,
        idempotent: false,
        config: decided.payload,
      };
    }

    await rtdb.ref(`well_config/${decided.wellName}`).set(decided.payload);

    await writeSecurityAudit({
      action: 'staffWriteWellConfig',
      actorUid: caller.uid,
      detail: { op: 'create', wellName: decided.wellName, created: true },
    });

    return {
      ok: true as const,
      wellName: decided.wellName,
      created: true,
      updated: false,
      idempotent: false,
      config: decided.payload,
    };
  },
);
