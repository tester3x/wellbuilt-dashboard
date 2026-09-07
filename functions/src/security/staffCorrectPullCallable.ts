/**
 * Governed pull correction (staff/admin). Replaces the Dashboard's legacy
 * deletePull/editPull direct client writes to packets/incoming — which the
 * deployed secure RTDB rules deny (packets/incoming .write:false), the proven
 * cause of "Failed to delete pull".
 *
 * The actor, company, and authorization are derived from the authenticated
 * session; the client never supplies a tenant. Identity is the immutable
 * packetId plus the SERVER-stored wellName (never the display name alone).
 * The callable admin-writes a governed packet to packets/incoming under a
 * deterministic key so the existing V1 triggers (processDeleteRequest /
 * processMoveRequest) recompute canonical state. Idempotent: an already-gone or
 * already-moved pull returns a truthful acknowledgement without re-queuing.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  evaluatePullCorrection,
  correctionIncomingKey,
} from './operational/pullCorrectionAuthorize';

const ALLOWED = new Set(['op', 'packetId', 'fromWell', 'toWell']);

export const staffCorrectPull = httpsV2.onCall(
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
    const op = raw.op;
    const packetId = typeof raw.packetId === 'string' ? raw.packetId.trim() : '';
    const fromWell = typeof raw.fromWell === 'string' ? raw.fromWell.trim() : '';
    const toWell = typeof raw.toWell === 'string' ? raw.toWell.trim() : '';

    const rtdb = admin.database();
    const [processedSnap, wellConfigSnap] = await Promise.all([
      packetId && !/[.$#[\]/]/.test(packetId)
        ? rtdb.ref(`packets/processed/${packetId}`).once('value')
        : Promise.resolve({ exists: () => false, val: () => null } as admin.database.DataSnapshot),
      rtdb.ref('well_config').once('value'),
    ]);
    const processed = processedSnap.exists()
      ? (processedSnap.val() as Record<string, unknown>)
      : null;
    const wellConfig = wellConfigSnap.exists()
      ? (wellConfigSnap.val() as Record<string, unknown>)
      : {};

    const decided = evaluatePullCorrection({
      op,
      packetId,
      fromWell,
      toWell,
      processed,
      wellConfig,
      caller: {
        companyId: caller.companyId,
        isPlatformAdmin: caller.isPlatformAdmin,
        caps: caller.caps,
      },
    });

    if (!decided.ok) {
      throw new httpsV2.HttpsError(decided.code, `${decided.reason}:${decided.message}`);
    }

    // Idempotent short-circuits — the correction is already in the desired state.
    if (decided.action === 'already_gone' || decided.action === 'already_moved') {
      await writeSecurityAudit({
        action: 'staffCorrectPull',
        actorUid: caller.uid,
        detail: { op: decided.op, packetId: decided.packetId, idempotent: true, action: decided.action },
      });
      return {
        ok: true as const,
        op: decided.op,
        packetId: decided.packetId,
        queued: false as const,
        idempotent: true as const,
        alreadyApplied: true as const,
      };
    }

    const key = correctionIncomingKey(decided.op, decided.packetId);
    const nowIso = new Date().toISOString();
    const packet =
      decided.op === 'delete'
        ? {
            requestType: 'delete' as const,
            packetId: decided.packetId,
            wellName: decided.wellName,
            source: 'dashboard-governed',
            correctedBy: caller.uid,
            correctedAt: nowIso,
            idempotencyKey: key,
          }
        : {
            requestType: 'move' as const,
            packetId: decided.packetId,
            fromWell: decided.fromWell,
            toWell: decided.toWell,
            wellName: decided.fromWell, // legacy readers expect wellName = current well
            source: 'dashboard-governed',
            movedBy: caller.uid,
            movedAt: nowIso,
            idempotencyKey: key,
          };

    // Single-flight: a deterministic key + transaction collapses concurrent
    // retries into one governed packet.
    const ref = rtdb.ref(`packets/incoming/${key}`);
    const box: { outcome: 'write' | 'duplicate' } = { outcome: 'write' };
    const tx = await ref.transaction((current) => {
      if (current && typeof current === 'object') {
        box.outcome = 'duplicate';
        return current; // leave the in-flight packet untouched
      }
      box.outcome = 'write';
      return packet;
    });
    if (!tx.committed) {
      throw new httpsV2.HttpsError('failed-precondition', 'correction_conflict:Could not queue the correction.');
    }

    await writeSecurityAudit({
      action: 'staffCorrectPull',
      actorUid: caller.uid,
      detail: {
        op: decided.op,
        packetId: decided.packetId,
        ...(decided.op === 'move'
          ? { fromWell: decided.fromWell, toWell: decided.toWell }
          : { wellName: decided.wellName }),
        key,
        duplicate: box.outcome === 'duplicate',
      },
    });

    return {
      ok: true as const,
      op: decided.op,
      packetId: decided.packetId,
      key,
      queued: true as const,
      idempotent: box.outcome === 'duplicate',
      alreadyApplied: false as const,
    };
  },
);
