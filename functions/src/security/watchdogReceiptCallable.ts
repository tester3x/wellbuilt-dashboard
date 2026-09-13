/**
 * getWatchdogPullReceipt — Status query endpoint for submitted Watchdog packet IDs.
 *
 * Dedicated Watchdog principal only (custom claim kind=watchdog).
 * Tenant-scoped: returns status only for packets belonging to caller's company.
 * Reports queued, processed (with canonical completion marker & well status), or rejected.
 * Does not grant general RTDB or Firestore read access.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireWatchdogPrincipal } from './watchdogPullCallable';
import { isFirebaseKeySafe } from './operational/wbmPullAuthorize';

export const getWatchdogPullReceipt = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = requireWatchdogPrincipal(request);
    const data = (request.data || {}) as Record<string, unknown>;

    const packetId = typeof data.packetId === 'string' ? data.packetId.trim() : '';
    if (!packetId || !isFirebaseKeySafe(packetId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'packetId_invalid:A valid packetId is required.');
    }

    const rtdb = admin.database();

    // 1. Check packets/processed
    const processedSnap = await rtdb.ref(`packets/processed/${packetId}`).once('value');
    if (processedSnap.exists()) {
      const processed = processedSnap.val() as Record<string, unknown>;
      // Strict tenant boundary: never reveal another company's packet
      if (processed.companyId && processed.companyId !== caller.companyId) {
        return { ok: true as const, found: false, status: 'not_found', packetId };
      }

      const wellName = String(processed.wellName || '');
      let wellStatus: Record<string, unknown> | null = null;
      if (wellName) {
        const wsSnap = await rtdb.ref(`wells/${wellName}/status`).once('value');
        if (wsSnap.exists()) {
          wellStatus = wsSnap.val() as Record<string, unknown>;
        }
      }

      return {
        ok: true as const,
        found: true,
        status: 'processed' as const,
        packetId,
        wellName,
        canonicalProcessingComplete: processed.canonicalProcessingComplete === true,
        wellStatus: wellStatus ? {
          currentLevel: (wellStatus.current as Record<string, unknown>)?.level,
          currentLevelInches: (wellStatus.current as Record<string, unknown>)?.levelInches,
          lastPullPacketId: (wellStatus.lastPull as Record<string, unknown>)?.packetId,
          updatedAt: wellStatus.updatedAt,
        } : null,
      };
    }

    // 2. Check packets/incoming
    const incomingSnap = await rtdb.ref(`packets/incoming/${packetId}`).once('value');
    if (incomingSnap.exists()) {
      const incoming = incomingSnap.val() as Record<string, unknown>;
      if (incoming.companyId && incoming.companyId !== caller.companyId) {
        return { ok: true as const, found: false, status: 'not_found', packetId };
      }

      return {
        ok: true as const,
        found: true,
        status: 'queued' as const,
        packetId,
        wellName: incoming.wellName,
        submittedAt: incoming.ingestedAtUtc || incoming.ingestedAt || null,
      };
    }

    // 3. Check packets/rejected
    const rejectedSnap = await rtdb.ref(`packets/rejected/${packetId}`).once('value');
    if (rejectedSnap.exists()) {
      const rejected = rejectedSnap.val() as Record<string, unknown>;
      if (rejected.companyId && rejected.companyId !== caller.companyId) {
        return { ok: true as const, found: false, status: 'not_found', packetId };
      }

      return {
        ok: true as const,
        found: true,
        status: 'rejected' as const,
        packetId,
        wellName: rejected.wellName,
        reason: rejected.reason || 'rejected',
      };
    }

    return {
      ok: true as const,
      found: false,
      status: 'not_found' as const,
      packetId,
    };
  },
);
