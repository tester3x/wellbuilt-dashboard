/**
 * Governed WB-M / WB-T edit ingest. Authenticated driver only.
 * Writes packets/incoming/edit_* for live processEditRequest.
 * Does not remint the original packet id or substitute "now" for empty time.
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

export type WbmEditIngestStatus = 'accepted' | 'duplicate' | 'conflict' | 'pending' | 'invalid';

export type WbmEditIngestResult =
  | {
    ok: true;
    status: 'pending' | 'duplicate';
    originalPacketId: string;
    idempotencyKey: string;
    payloadDigest: string;
    incomingPath: string;
  }
  | {
    ok: false;
    status: 'invalid' | 'conflict';
    reason: string;
  };

export async function runIngestWbmEdit(input: {
  packet: unknown;
  driverId: string;
  uid: string;
  displayName: string | null;
  authSource: string;
  companyId: string;
  assignedRoutes: unknown;
  assignedWells: unknown;
  wellConfig: Record<string, unknown>;
  original: Record<string, unknown> | null;
  writeIncoming: (
    path: string,
    decide: (current: Record<string, unknown> | null) =>
      | { action: 'write'; stamped: Record<string, unknown> }
      | { action: 'duplicate' }
      | { action: 'abort'; reason: string },
  ) => Promise<{ committed: boolean; outcome: 'write' | 'duplicate' | 'abort'; abortReason: string }>;
}): Promise<WbmEditIngestResult> {
  const decided = evaluateWbmEdit({
    packet: input.packet,
    companyId: input.companyId,
    driverId: input.driverId,
    assignedRoutes: input.assignedRoutes,
    assignedWells: input.assignedWells,
    wellConfig: input.wellConfig,
    original: input.original,
  });
  if (!decided.ok) {
    return { ok: false, status: 'invalid', reason: decided.reason };
  }

  const stamped: Record<string, unknown> = {
    ...decided.payload,
    driverId: input.driverId,
    driverName: input.displayName,
    companyId: input.companyId,
    ingestedAt: Date.now(),
    ingestedBy: input.uid,
    authSource: input.authSource,
    payloadDigest: decided.payloadDigest,
  };

  const path = wbmEditIncomingPath(decided.idempotencyKey);
  const tx = await input.writeIncoming(path, (existing) => {
    const gate = decideWbmEditTransaction({
      existing,
      driverId: input.driverId,
      payloadDigest: decided.payloadDigest,
    });
    if (gate.action === 'write') return { action: 'write', stamped };
    if (gate.action === 'duplicate') return { action: 'duplicate' };
    return { action: 'abort', reason: gate.reason };
  });

  if (!tx.committed || tx.outcome === 'abort') {
    return { ok: false, status: 'conflict', reason: tx.abortReason };
  }
  return {
    ok: true,
    status: tx.outcome === 'duplicate' ? 'duplicate' : 'pending',
    originalPacketId: decided.originalPacketId,
    idempotencyKey: decided.idempotencyKey,
    payloadDigest: decided.payloadDigest,
    incomingPath: path,
  };
}

export const ingestWbmEdit = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { packet?: unknown; companyId?: unknown };
    if (data.companyId !== undefined) {
      throw new httpsV2.HttpsError('invalid-argument', 'unexpected_field');
    }
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

    const result = await runIngestWbmEdit({
      packet: data.packet,
      driverId: driver.driverId,
      uid: driver.uid,
      displayName: driver.displayName || null,
      authSource: driver.authSource,
      companyId: authority.companyId,
      assignedRoutes: profile.assignedRoutes,
      assignedWells: profile.assignedWells,
      wellConfig,
      original,
      writeIncoming: async (path, decide) => {
        const ref = admin.database().ref(path);
        const box: { outcome: 'write' | 'duplicate' | 'abort'; abortReason: string } = {
          outcome: 'write',
          abortReason: 'ingest_conflict',
        };
        const tx = await ref.transaction((current) => {
          const existing = current && typeof current === 'object'
            ? current as Record<string, unknown>
            : null;
          const gate = decide(existing);
          if (gate.action === 'write') {
            box.outcome = 'write';
            return gate.stamped;
          }
          if (gate.action === 'duplicate') {
            box.outcome = 'duplicate';
            return current;
          }
          box.outcome = 'abort';
          box.abortReason = gate.reason;
          return;
        });
        return { committed: tx.committed, outcome: box.outcome, abortReason: box.abortReason };
      },
    });

    if (!result.ok) {
      return result;
    }

    await writeSecurityAudit({
      action: result.status === 'duplicate' ? 'ingestWbmEdit_idempotent' : 'ingestWbmEdit',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { key: result.idempotencyKey, companyId: authority.companyId, status: result.status },
    });
    return result;
  },
);
