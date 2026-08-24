/**
 * Staff create for RTDB well_config. Client writes are denied.
 * Create only — this packet does not edit or delete existing wells.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  evaluateStaffWriteWellConfig,
  findDuplicateApiWell,
  findWellNameKey,
} from './operational/staffWriteWellConfig';

const ALLOWED = new Set(['op', 'wellName', 'config']);

export const staffWriteWellConfig = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    if (raw.op !== 'create') {
      throw new httpsV2.HttpsError('invalid-argument', 'op must be create');
    }
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
    const duplicateApiWell = findDuplicateApiWell(all, requestedApi, wellName);

    const decided = evaluateStaffWriteWellConfig({
      op: 'create',
      wellName,
      config,
      existingByName,
      existingNameKey,
      duplicateApiWell,
      callerCompanyId: caller.companyId,
      isPlatformAdmin: caller.isPlatformAdmin,
    });

    if (!decided.ok) {
      const code = decided.reason === 'pool_forbidden' ? 'permission-denied'
        : decided.reason === 'name_taken' || decided.reason === 'duplicate_api' ? 'already-exists'
        : 'invalid-argument';
      throw new httpsV2.HttpsError(code, `${decided.reason}:${decided.message}`);
    }

    if (decided.action === 'already_exact') {
      await writeSecurityAudit({
        action: 'staffWriteWellConfig',
        actorUid: caller.uid,
        detail: { op: 'create', wellName: decided.wellName, idempotent: true },
      });
      return {
        ok: true as const,
        wellName: decided.wellName,
        created: false,
        idempotent: true,
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
      idempotent: false,
      config: decided.payload,
    };
  },
);
