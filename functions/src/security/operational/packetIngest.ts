/**
 * Secure packet ingest — replaces client PUT to packets/incoming.
 * Admin SDK write; processIncomingPull RTDB trigger remains authority for processing.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver, assertSameCompany } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';
import { checkRateLimit, hashIp } from '../rateLimit';

const MAX_PACKET_BYTES = 200_000;

function packetKey(packet: Record<string, unknown>, driverId: string): string {
  // Prefer client idempotency key
  if (typeof packet.idempotencyKey === 'string' && packet.idempotencyKey.length >= 8) {
    return `idem_${packet.idempotencyKey.replace(/[.#$\[\]/]/g, '_').slice(0, 80)}`;
  }
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${ts}_${driverId.slice(0, 12)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const ingestDriverPacket = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      packet?: Record<string, unknown>;
      driverHash?: string; // transitional
    };
    if (!data.packet || typeof data.packet !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'packet required');
    }
    const raw = JSON.stringify(data.packet);
    if (raw.length > MAX_PACKET_BYTES) {
      throw new httpsV2.HttpsError('invalid-argument', 'packet too large');
    }

    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    const ip =
      (request.rawRequest?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.rawRequest?.ip;
    const allowed = await checkRateLimit({
      bucket: 'packet_ingest',
      key: `${driver.driverId}:${hashIp(ip)}`,
      limit: 120,
      windowMs: 60 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'Packet rate limit');
    }

    const packet = { ...data.packet };
    // Server stamps — client cannot spoof identity fields
    packet.driverId = driver.driverId;
    if (driver.displayName) packet.driverName = driver.displayName;
    if (driver.companyId) {
      packet.companyId = driver.companyId;
      assertSameCompany(driver.companyId, packet.companyId as string);
    }
    packet.ingestedAt = Date.now();
    packet.ingestedBy = driver.uid;
    packet.authSource = driver.authSource;
    // Strip privilege fields if client sent them
    delete (packet as any).isAdmin;
    delete (packet as any).roles;
    delete (packet as any).tier;

    const key = packetKey(packet, driver.driverId);
    const ref = admin.database().ref(`packets/incoming/${key}`);
    const existing = await ref.once('value');
    if (existing.exists()) {
      // Idempotent replay
      await writeSecurityAudit({
        action: 'ingestDriverPacket_idempotent',
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { key },
      });
      return { ok: true, key, duplicate: true };
    }

    await ref.set(packet);
    await writeSecurityAudit({
      action: 'ingestDriverPacket',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { key, companyId: driver.companyId || null },
    });
    return { ok: true, key, duplicate: false };
  },
);
