/**
 * Server proof that a local pull matches processed/{id} or processed/idem_{id}.
 * Tenant-contained. Never writes.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  decideProcessedPullReconcile,
  legacyIdemStorageKey,
} from './packetReconcileCore';

export const reconcileDriverPacket = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      packetId?: string;
      wellName?: string;
      dateTimeUTC?: string;
      bblsTaken?: number;
      tankLevelFeet?: number;
      driverHash?: string;
    };
    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('failed-precondition', 'company_required');
    }
    const packetId = (data.packetId || '').trim();
    if (!packetId) throw new httpsV2.HttpsError('invalid-argument', 'packetId required');

    const exactSnap = await admin.database().ref(`packets/processed/${packetId}`).once('value');
    const legacySnap = await admin.database()
      .ref(`packets/processed/${legacyIdemStorageKey(packetId)}`)
      .once('value');
    const exact = exactSnap.exists() ? (exactSnap.val() as Record<string, unknown>) : null;
    const legacyIdem = legacySnap.exists() ? (legacySnap.val() as Record<string, unknown>) : null;

    const decided = decideProcessedPullReconcile({
      canonicalPacketId: packetId,
      driverId: driver.driverId,
      companyId: driver.companyId,
      localIdentity: {
        wellName: data.wellName,
        dateTimeUTC: data.dateTimeUTC,
        bblsTaken: data.bblsTaken,
        tankLevelFeet: data.tankLevelFeet,
      },
      exact,
      legacyIdem,
    });

    if (!decided.match) {
      return {
        ok: true,
        match: false,
        reason: decided.reason,
        canonicalPacketId: packetId,
      };
    }
    return {
      ok: true,
      match: true,
      location: decided.location,
      canonicalPacketId: decided.canonicalPacketId,
    };
  },
);
