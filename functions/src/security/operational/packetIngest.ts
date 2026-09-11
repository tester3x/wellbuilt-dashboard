/**
 * Secure WB-T packet ingest — replaces client PUT to packets/incoming.
 * Admin SDK write; processIncomingPull RTDB trigger remains authority for processing.
 * Storage identity is the client-minted packetId (never idem_ rewrite).
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';
import { checkRateLimit, hashIp } from '../rateLimit';
import {
  decideWbtPullTransaction,
  evaluateWbtDriverPacket,
  wbtIncomingPath,
  wbtPullStorageKey,
} from './wbtPacketAuthorize';
import {
  decideProcessedPullReconcile,
  legacyIdemStorageKey,
} from './packetReconcileCore';

const MAX_PACKET_BYTES = 200_000;

export const ingestDriverPacket = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      packet?: Record<string, unknown>;
      driverHash?: string; // transitional; never used as storage identity
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
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('failed-precondition', 'company_required');
    }

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

    const wellSnap = await admin.database().ref('well_config').once('value');
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};
    const decided = evaluateWbtDriverPacket({
      packet: data.packet,
      companyId: driver.companyId,
      wellConfig,
    });
    if (!decided.ok) {
      const arg = new Set([
        'packet_required', 'packet_too_large', 'unsupported_request_type', 'unexpected_field',
        'unexpected_object', 'missing_wellName', 'invalid_wellName', 'missing_dateTimeUTC',
        'invalid_dateTimeUTC', 'invalid_tankLevelFeet', 'invalid_bblsTaken', 'invalid_wellDown',
        'invalid_wellDownIsAuthoritative', 'invalid_predictedLevelInches', 'invalid_packetId',
        'missing_packetId', 'missing_idempotency_key', 'packet_id_mismatch',
        'invalid_originAppContext', 'invalid_invoicingMode', 'invalid_companyId',
      ]);
      const denied = new Set(['cross_company_packet', 'cross_company_well']);
      if (denied.has(decided.reason)) {
        throw new httpsV2.HttpsError('permission-denied', decided.reason);
      }
      throw new httpsV2.HttpsError(
        arg.has(decided.reason) ? 'invalid-argument' : 'failed-precondition',
        decided.reason,
      );
    }

    const stamped: Record<string, unknown> = {
      ...decided.payload,
      driverId: driver.driverId,
      driverName: driver.displayName || (typeof data.packet.driverName === 'string' ? data.packet.driverName : null),
      companyId: driver.companyId,
      ingestedAt: Date.now(),
      ingestedBy: driver.uid,
      authSource: driver.authSource,
      payloadDigest: decided.payloadDigest,
    };
    delete (stamped as any).isAdmin;
    delete (stamped as any).roles;
    delete (stamped as any).tier;

    const key = wbtPullStorageKey(decided.packetId);

    const [exactProcessed, legacyProcessed] = await Promise.all([
      admin.database().ref(`packets/processed/${key}`).once('value'),
      admin.database().ref(`packets/processed/${legacyIdemStorageKey(key)}`).once('value'),
    ]);
    const proven = decideProcessedPullReconcile({
      canonicalPacketId: key,
      driverId: driver.driverId,
      companyId: driver.companyId,
      localIdentity: decided.payload,
      exact: exactProcessed.exists() ? (exactProcessed.val() as Record<string, unknown>) : null,
      legacyIdem: legacyProcessed.exists() ? (legacyProcessed.val() as Record<string, unknown>) : null,
    });
    if (proven.match) {
      await writeSecurityAudit({
        action: 'ingestDriverPacket_reconciled',
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { key, packetId: key, location: proven.location },
      });
      return {
        ok: true,
        key,
        packetId: key,
        duplicate: true,
        result: 'already_exists',
        location: proven.location,
      };
    }
    if (proven.reason === 'payload_mismatch' || proven.reason === 'cross_tenant') {
      throw new httpsV2.HttpsError('failed-precondition', proven.reason);
    }

    const ref = admin.database().ref(wbtIncomingPath(decided.packetId));
    const box: { outcome: 'write' | 'duplicate' | 'abort'; abortReason: string } = {
      outcome: 'write',
      abortReason: 'ingest_conflict',
    };
    const tx = await ref.transaction((current) => {
      const existing = current && typeof current === 'object'
        ? current as Record<string, unknown>
        : null;
      const gate = decideWbtPullTransaction({
        existing,
        driverId: driver.driverId,
        payloadDigest: decided.payloadDigest,
      });
      if (gate.action === 'write') {
        box.outcome = 'write';
        return stamped;
      }
      if (gate.action === 'duplicate') {
        box.outcome = 'duplicate';
        return current;
      }
      box.outcome = 'abort';
      box.abortReason = gate.reason;
      return;
    });

    if (!tx.committed || box.outcome === 'abort') {
      throw new httpsV2.HttpsError('failed-precondition', box.abortReason);
    }

    if (box.outcome === 'duplicate') {
      await writeSecurityAudit({
        action: 'ingestDriverPacket_idempotent',
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { key, packetId: key },
      });
      return { ok: true, key, packetId: key, duplicate: true, result: 'already_exists' };
    }

    await writeSecurityAudit({
      action: 'ingestDriverPacket',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { key, packetId: key, companyId: driver.companyId, wellName: decided.wellName },
    });
    return { ok: true, key, packetId: key, duplicate: false, result: 'created' };
  },
);
