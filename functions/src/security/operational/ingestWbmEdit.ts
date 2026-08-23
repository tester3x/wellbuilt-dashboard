/**
 * Governed WB-M edit ingest. Authenticated driver only. Writes the
 * deterministic packets/incoming/edit_* key so live processEditRequest
 * can apply. Does not replace or merge the live processor body.
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
  decideWbmEditTransaction,
  evaluateWbmEdit,
  wbmEditIncomingPath,
} from './wbmEditAuthorize';

const ARG = new Set([
  'packet_required', 'packet_too_large', 'unsupported_request_type', 'unexpected_field',
  'unexpected_object', 'missing_wellName', 'invalid_wellName', 'missing_originalPacketId',
  'invalid_originalPacketId', 'invalid_tankLevelFeet', 'invalid_bblsTaken', 'invalid_wellDown',
  'invalid_wellDownIsAuthoritative', 'invalid_dateTimeUTC', 'invalid_dateTime', 'invalid_timezone',
  'missing_idempotency_key', 'idempotency_key_mismatch',
]);

const PERM = new Set([
  'cross_driver', 'cross_company_well', 'well_out_of_scope', 'forged_well', 'well_not_found',
]);

export const ingestWbmEdit = httpsV2.onCall(
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

    const origIdGuess = (() => {
      const p = data.packet && typeof data.packet === 'object' && !Array.isArray(data.packet)
        ? data.packet as Record<string, unknown>
        : null;
      const raw = p && (p.originalPacketId || p.packetId);
      return typeof raw === 'string' ? raw.trim() : '';
    })();

    const [profSnap, wellSnap, origSnap] = await Promise.all([
      admin.database().ref(`drivers/profiles/${driver.driverId}`).once('value'),
      admin.database().ref('well_config').once('value'),
      origIdGuess
        ? admin.database().ref(`packets/processed/${origIdGuess}`).once('value')
        : Promise.resolve({ exists: () => false, val: () => null } as admin.database.DataSnapshot),
    ]);
    if (!profSnap.exists()) {
      throw new httpsV2.HttpsError('failed-precondition', 'profile_missing');
    }
    const profile = (profSnap.val() || {}) as Record<string, unknown>;
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};
    const original = origSnap.exists() ? (origSnap.val() as Record<string, unknown>) : null;

    const decided = evaluateWbmEdit({
      packet: data.packet,
      companyId: authority.companyId,
      driverId: driver.driverId,
      assignedRoutes: profile.assignedRoutes,
      assignedWells: profile.assignedWells,
      wellConfig,
      original,
    });
    if (!decided.ok) {
      throw new httpsV2.HttpsError(
        ARG.has(decided.reason) ? 'invalid-argument'
          : PERM.has(decided.reason) ? 'permission-denied'
            : 'failed-precondition',
        decided.reason,
      );
    }

    const ip =
      (request.rawRequest?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.rawRequest?.ip;
    const allowed = await checkRateLimit({
      bucket: 'wbm_edit_ingest',
      key: `${driver.driverId}:${hashIp(ip)}`,
      limit: 60,
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

    const key = decided.idempotencyKey;
    const ref = admin.database().ref(wbmEditIncomingPath(key));
    const box: { outcome: 'write' | 'duplicate' | 'abort'; abortReason: string } = {
      outcome: 'write',
      abortReason: 'ingest_conflict',
    };
    const tx = await ref.transaction((current) => {
      const existing = current && typeof current === 'object'
        ? current as Record<string, unknown>
        : null;
      const gate = decideWbmEditTransaction({
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

    await writeSecurityAudit({
      action: box.outcome === 'duplicate' ? 'ingestWbmEdit_idempotent' : 'ingestWbmEdit',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { key, companyId: authority.companyId, wellName: decided.wellName },
    });

    return {
      ok: true as const,
      key,
      packetId: decided.originalPacketId,
      idempotencyKey: key,
      duplicate: box.outcome === 'duplicate',
      queued: true as const,
      committed: false as const,
    };
  },
);
