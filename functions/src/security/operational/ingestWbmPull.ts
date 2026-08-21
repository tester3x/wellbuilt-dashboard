/**
 * Dedicated canonical WB-M pull ingest. Does not alter ingestDriverPacket
 * (WB-T still uses that shared callable).
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
} from '../canonicalDriverAuthority';
import { writeSecurityAudit } from '../audit';
import { checkRateLimit, hashIp } from '../rateLimit';
import { evaluateWbmPull, wbmPullIdempotencyKey } from './wbmPullAuthorize';

export const ingestWbmPull = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { packet?: unknown };
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    const authority = await loadCanonicalDriverAuthority(
      driver.driverId,
      productionCanonicalDriverReaders(),
    );
    if (!authority || !authority.active) {
      throw new httpsV2.HttpsError('permission-denied', 'driver_inactive');
    }
    if (!authority.companyId) {
      throw new httpsV2.HttpsError('failed-precondition', 'company_required');
    }

    const profSnap = await admin.database().ref(`drivers/profiles/${driver.driverId}`).once('value');
    if (!profSnap.exists()) {
      throw new httpsV2.HttpsError('failed-precondition', 'profile_missing');
    }
    const profile = (profSnap.val() || {}) as Record<string, unknown>;

    const wellSnap = await admin.database().ref('well_config').once('value');
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};

    const decided = evaluateWbmPull({
      packet: data.packet,
      companyId: authority.companyId,
      assignedRoutes: profile.assignedRoutes,
      assignedWells: profile.assignedWells,
      wellConfig,
    });
    if (!decided.ok) {
      throw new httpsV2.HttpsError(
        decided.reason.startsWith('missing_') || decided.reason === 'packet_required'
          || decided.reason === 'packet_too_large' || decided.reason === 'unsupported_request_type'
          ? 'invalid-argument'
          : 'failed-precondition',
        decided.reason,
      );
    }

    const ip =
      (request.rawRequest?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.rawRequest?.ip;
    const allowed = await checkRateLimit({
      bucket: 'wbm_pull_ingest',
      key: `${driver.driverId}:${hashIp(ip)}`,
      limit: 120,
      windowMs: 60 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'Packet rate limit');
    }

    const packet = { ...(data.packet as Record<string, unknown>) };
    packet.driverId = driver.driverId;
    if (driver.displayName) packet.driverName = driver.displayName;
    packet.companyId = authority.companyId;
    packet.ingestedAt = Date.now();
    packet.ingestedBy = driver.uid;
    packet.authSource = driver.authSource;
    packet.requestType = 'pull';
    delete (packet as { isAdmin?: unknown }).isAdmin;
    delete (packet as { roles?: unknown }).roles;
    delete (packet as { tier?: unknown }).tier;

    const key = wbmPullIdempotencyKey(driver.driverId, decided.idempotencyKey);
    const ref = admin.database().ref(`packets/incoming/${key}`);
    const existing = await ref.once('value');
    if (existing.exists()) {
      const prev = existing.val() as Record<string, unknown>;
      if (prev.driverId && prev.driverId !== driver.driverId) {
        throw new httpsV2.HttpsError('failed-precondition', 'idempotency_cross_driver');
      }
      await writeSecurityAudit({
        action: 'ingestWbmPull_idempotent',
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { key },
      });
      return { ok: true, key, duplicate: true };
    }

    await ref.set(packet);
    await writeSecurityAudit({
      action: 'ingestWbmPull',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { key, companyId: authority.companyId, wellName: decided.wellName },
    });
    return { ok: true, key, duplicate: false };
  },
);
