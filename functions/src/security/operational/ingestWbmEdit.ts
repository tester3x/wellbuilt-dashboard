/**
 * Governed WB-M / WB-T edit ingest. Authenticated driver only.
 * Writes packets/incoming/{editEventId} for live processEditRequest.
 * Does not remint the original packet id or substitute "now" for empty time.
 *
 * Completion: pending while queued; accepted once packets/editReceipts/{editEventId}
 * has this digest; conflict when the same event id has different bytes.
 * Incoming write success is NOT applied — WB-T must not clear its outbox on pending.
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
  decideWbmEditReceipt,
  decideWbmEditTransaction,
  evaluateWbmEdit,
  wbmEditIncomingPath,
  wbmEditReceiptPath,
} from './wbmEditAuthorize';
import { applyStatePath, parseApplyState } from './governedEditApplyState';

export type WbmEditIngestStatus =
  | 'accepted'
  | 'duplicate'
  | 'conflict'
  | 'pending'
  | 'invalid'
  | 'acknowledged'
  | 'rejected';

export type WbmEditIngestResult =
  | {
    ok: true;
    status: 'pending' | 'accepted' | 'duplicate' | 'acknowledged' | 'rejected';
    originalPacketId: string;
    editEventId: string;
    idempotencyKey: string;
    payloadDigest: string;
    incomingPath: string;
    reason?: string;
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
  readReceipt: (editEventId: string) => Promise<Record<string, unknown> | null>;
  writeIncoming: (
    path: string,
    decide: (current: Record<string, unknown> | null) =>
      | { action: 'write'; stamped: Record<string, unknown> }
      | { action: 'queued' }
      | { action: 'abort'; reason: string },
  ) => Promise<{ committed: boolean; outcome: 'write' | 'queued' | 'abort'; abortReason: string }>;
  /** When incoming is already queued, bump resume so onWrite re-enters apply. */
  onQueuedResume?: (path: string, editEventId: string) => Promise<void>;
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

  const receipt = await input.readReceipt(decided.editEventId);
  const receiptGate = decideWbmEditReceipt({
    receipt,
    payloadDigest: decided.payloadDigest,
    editEventId: decided.editEventId,
    originalPacketId: decided.originalPacketId,
  });
  if (receiptGate.action === 'accepted') {
    return {
      ok: true,
      status: 'accepted',
      originalPacketId: decided.originalPacketId,
      editEventId: decided.editEventId,
      idempotencyKey: decided.idempotencyKey,
      payloadDigest: decided.payloadDigest,
      incomingPath: wbmEditIncomingPath(decided.editEventId),
    };
  }
  if (receiptGate.action === 'acknowledged' || receiptGate.action === 'rejected') {
    return {
      ok: true,
      status: receiptGate.action,
      originalPacketId: decided.originalPacketId,
      editEventId: decided.editEventId,
      idempotencyKey: decided.idempotencyKey,
      payloadDigest: decided.payloadDigest,
      incomingPath: wbmEditIncomingPath(decided.editEventId),
      reason: typeof receipt?.reason === 'string' ? receipt.reason : undefined,
    };
  }
  if (receiptGate.action === 'abort') {
    return { ok: false, status: 'conflict', reason: receiptGate.reason };
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

  const path = wbmEditIncomingPath(decided.editEventId);
  const tx = await input.writeIncoming(path, (existing) => {
    const gate = decideWbmEditTransaction({
      existing,
      driverId: input.driverId,
      payloadDigest: decided.payloadDigest,
    });
    if (gate.action === 'write') return { action: 'write', stamped };
    if (gate.action === 'queued') return { action: 'queued' };
    return { action: 'abort', reason: gate.reason };
  });

  if (!tx.committed || tx.outcome === 'abort') {
    return { ok: false, status: 'conflict', reason: tx.abortReason };
  }
  if (tx.outcome === 'queued' && input.onQueuedResume) {
    await input.onQueuedResume(path, decided.editEventId);
  }
  return {
    ok: true,
    status: 'pending',
    originalPacketId: decided.originalPacketId,
    editEventId: decided.editEventId,
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
      readReceipt: async (editEventId) => {
        const snap = await admin.database().ref(wbmEditReceiptPath(editEventId)).once('value');
        return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
      },
      writeIncoming: async (path, decide) => {
        const ref = admin.database().ref(path);
        const box: { outcome: 'write' | 'queued' | 'abort'; abortReason: string } = {
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
          if (gate.action === 'queued') {
            box.outcome = 'queued';
            return current;
          }
          box.outcome = 'abort';
          box.abortReason = gate.reason;
          return;
        });
        return { committed: tx.committed, outcome: box.outcome, abortReason: box.abortReason };
      },
      onQueuedResume: async (path, editEventId) => {
        const snap = await admin.database().ref(applyStatePath(editEventId)).once('value');
        const st = parseApplyState(snap.val());
        if (!st || st.phase === 'terminal') return;
        await admin.database().ref(path).update({ resumeAt: Date.now() });
      },
    });

    if (!result.ok) {
      return result;
    }

    await writeSecurityAudit({
      action: result.status === 'accepted' || result.status === 'duplicate'
        ? 'ingestWbmEdit_applied'
        : 'ingestWbmEdit',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: {
        key: result.editEventId,
        originalPacketId: result.originalPacketId,
        companyId: authority.companyId,
        status: result.status,
      },
    });
    return result;
  },
);
