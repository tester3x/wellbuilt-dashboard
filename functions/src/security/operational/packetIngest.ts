/**
 * Secure packet ingest — replaces client PUT to packets/incoming.
 * Admin SDK write; processIncomingPull RTDB trigger remains authority for processing.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver, assertSameCompany } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';
import { checkRateLimit, hashIp } from '../rateLimit';
import { canonicalIngestStorageKey, sameIngestOwner } from './packetReconcileCore';

const MAX_PACKET_BYTES = 200_000;

function packetKey(packet: Record<string, unknown>, driverId: string): string {
  // The key stored in incoming/ (and later processed/) must be the identity
  // returned to the client. An idem_ alias is supported only for old records.
  const canonical = canonicalIngestStorageKey(packet);
  if (canonical) return canonical;
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
    if (key.length > 160 || /[.#$\[\]/]/.test(key) || key.startsWith('idem_')) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_packet_id');
    }
    packet.packetId = key;
    if (typeof packet.idempotencyKey === 'string') {
      packet.idempotencyKey = packet.idempotencyKey.trim();
    }
    // Return the same identity we store. For current clients this is their
    // packetId; older clients may supply only an idempotencyKey. The generated
    // fallback is returned when neither exists. In every case, a successful
    // ingest can retire the local queue entry without an idem_ alias.
    const canonicalPacketId = key;
    const ref = admin.database().ref(`packets/incoming/${key}`);
    const [existing, processed] = await Promise.all([
      ref.once('value'),
      admin.database().ref(`packets/processed/${key}`).once('value'),
    ]);
    if (processed.exists()) {
      if (!sameIngestOwner(processed.val() as Record<string, unknown>, packet, key)) {
        throw new httpsV2.HttpsError('already-exists', 'packet_id_collision');
      }
      return { ok: true, key, packetId: canonicalPacketId, duplicate: true };
    }
    if (existing.exists()) {
      if (!sameIngestOwner(existing.val() as Record<string, unknown>, packet, key)) {
        throw new httpsV2.HttpsError('already-exists', 'packet_id_collision');
      }
      // Idempotent replay
      await writeSecurityAudit({
        action: 'ingestDriverPacket_idempotent',
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { key },
      });
      return { ok: true, key, packetId: canonicalPacketId, duplicate: true };
    }

    // A prior app version may already have accepted this same pull under an
    // idem_ key. Do not create a second canonical incoming record on retry.
    const idempotencyId = typeof packet.idempotencyKey === 'string'
      ? packet.idempotencyKey.trim() : '';
    if (idempotencyId) {
      const legacyKey = `idem_${idempotencyId.replace(/[.#$\[\]/]/g, '_').slice(0, 80)}`;
      if (legacyKey !== key) {
        const [legacyIncoming, legacyProcessed] = await Promise.all([
          admin.database().ref(`packets/incoming/${legacyKey}`).once('value'),
          admin.database().ref(`packets/processed/${legacyKey}`).once('value'),
        ]);
        const old = legacyProcessed.exists() ? legacyProcessed.val() : legacyIncoming.val();
        if (old) {
          if (!sameIngestOwner(old as Record<string, unknown>, packet, key)) {
            throw new httpsV2.HttpsError('already-exists', 'legacy_packet_id_collision');
          }
          return { ok: true, key: legacyKey, packetId: canonicalPacketId, duplicate: true };
        }
      }
    }

    await ref.set(packet);
    await writeSecurityAudit({
      action: 'ingestDriverPacket',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { key, companyId: driver.companyId || null },
    });
    return { ok: true, key, packetId: canonicalPacketId, duplicate: false };
  },
);
