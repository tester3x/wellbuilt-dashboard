/**
 * Governed Dashboard pull DELETE (staff/admin). Replaces the legacy direct
 * client RTDB write to packets/incoming — which the deployed secure rules deny
 * (packets/incoming .write:false), the proven cause of "Failed to delete pull".
 *
 * The actor, company, and authorization are derived from the authenticated
 * session; the client never supplies a tenant. Identity is the immutable
 * packetId plus the SERVER-stored wellName (never the display name alone). The
 * callable admin-writes a governed delete packet to packets/incoming under a
 * deterministic key so the existing, proven processDeleteRequest trigger removes
 * the pull and recomputes outgoing / AFR / performance. Idempotent: an
 * already-gone pull returns a truthful acknowledgement without re-queuing; a
 * concurrent duplicate collapses onto the same in-flight packet.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import { evaluateDeletePull, deleteIncomingKey } from './operational/deletePullAuthorize';

const ALLOWED = new Set(['packetId', 'wellName']);

export const staffDeletePull = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    // Authenticated actor + role/capability, derived server-side.
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
    const packetId = typeof raw.packetId === 'string' ? raw.packetId.trim() : '';
    const wellName = typeof raw.wellName === 'string' ? raw.wellName.trim() : '';

    const rtdb = admin.database();
    const processedSnap =
      packetId && !/[.$#[\]/]/.test(packetId)
        ? await rtdb.ref(`packets/processed/${packetId}`).once('value')
        : ({ exists: () => false, val: () => null } as admin.database.DataSnapshot);
    const processed = processedSnap.exists()
      ? (processedSnap.val() as Record<string, unknown>)
      : null;

    const decided = evaluateDeletePull({
      packetId,
      wellName,
      processed,
      caller: {
        companyId: caller.companyId,
        isPlatformAdmin: caller.isPlatformAdmin,
        caps: caller.caps,
      },
    });

    if (!decided.ok) {
      throw new httpsV2.HttpsError(decided.code, `${decided.reason}:${decided.message}`);
    }

    // Idempotent short-circuit — the pull is already gone.
    if (decided.action === 'already_gone') {
      await writeSecurityAudit({
        action: 'staffDeletePull',
        actorUid: caller.uid,
        detail: { packetId: decided.packetId, wellName: decided.wellName, idempotent: true, action: 'already_gone' },
      });
      return {
        ok: true as const,
        packetId: decided.packetId,
        queued: false as const,
        idempotent: true as const,
        alreadyApplied: true as const,
      };
    }

    const key = deleteIncomingKey(decided.packetId);
    const packet = {
      requestType: 'delete' as const,
      packetId: decided.packetId,
      wellName: decided.wellName,
      source: 'dashboard-governed',
      deletedBy: caller.uid,
      deletedAt: new Date().toISOString(),
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
      throw new httpsV2.HttpsError('failed-precondition', 'delete_conflict:Could not queue the delete.');
    }

    await writeSecurityAudit({
      action: 'staffDeletePull',
      actorUid: caller.uid,
      detail: { packetId: decided.packetId, wellName: decided.wellName, key, duplicate: box.outcome === 'duplicate' },
    });

    return {
      ok: true as const,
      packetId: decided.packetId,
      key,
      queued: true as const,
      idempotent: box.outcome === 'duplicate',
      alreadyApplied: false as const,
    };
  },
);
