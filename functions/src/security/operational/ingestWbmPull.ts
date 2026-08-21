/**
 * Dedicated canonical WB-M pull ingest. Does not alter ingestDriverPacket.
 * Allowlisted packet only. RTDB transaction for idempotency.
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
import {
  decideWbmPullTransaction,
  evaluateWbmPull,
  wbmPullStorageKey,
} from './wbmPullAuthorize';

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
      const arg = new Set([
        'packet_required', 'packet_too_large', 'unsupported_request_type', 'unexpected_field',
        'unexpected_object', 'missing_wellName', 'invalid_wellName', 'missing_dateTimeUTC',
        'invalid_dateTimeUTC', 'invalid_dateTime', 'invalid_timezone', 'invalid_tankLevelFeet',
        'invalid_bblsTaken', 'invalid_wellDown', 'invalid_wellDownIsAuthoritative',
        'invalid_predictedLevelInches', 'invalid_packetId', 'missing_idempotency_key',
      ]);
      throw new httpsV2.HttpsError(
        arg.has(decided.reason) ? 'invalid-argument' : 'failed-precondition',
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

    const stamped: Record<string, unknown> = {
      ...decided.payload,
      driverId: driver.driverId,
      driverName: driver.displayName || null,
      companyId: authority.companyId,
      ingestedAt: Date.now(),
      ingestedBy: driver.uid,
      authSource: driver.authSource,
      payloadDigest: decided.payloadDigest,
    };

    const key = wbmPullStorageKey(driver.driverId, decided.idempotencyKey);
    const ref = admin.database().ref(`packets/incoming/${key}`);
    const box: { outcome: 'write' | 'duplicate' | 'abort'; abortReason: string } = {
      outcome: 'write',
      abortReason: 'ingest_conflict',
    };
    const tx = await ref.transaction((current) => {
      const existing = current && typeof current === 'object'
        ? current as Record<string, unknown>
        : null;
      const gate = decideWbmPullTransaction({
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
        action: 'ingestWbmPull_idempotent',
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { key },
      });
      return { ok: true, key, duplicate: true };
    }

    await writeSecurityAudit({
      action: 'ingestWbmPull',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { key, companyId: authority.companyId, wellName: decided.wellName },
    });
    return { ok: true, key, duplicate: false };
  },
);
