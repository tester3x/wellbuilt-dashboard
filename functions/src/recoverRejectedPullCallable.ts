// recoverRejectedPullCallable.ts — authenticated, company-scoped onCall wrapper
// around the pure recovery ladder in recoverRejectedPull.ts.
//
// Auth: authenticated driver (claims); the caller must own the rejected pull
// (same company + same driver). The decision is made by planRecovery(); this
// wrapper only supplies the read/write surface and executes the plan.
//
// Idempotent by construction:
//   - 'process'       → write the replacement to packets/incoming (canonical
//                       processIncomingPull materializes it). Same id/content on
//                       retry is harmless; the processor is id-idempotent.
//   - 'annotate_only' → the replacement is already processed but the rejected
//                       record is not yet annotated → write ONLY the annotation.
//   - 'noop_complete' → already fully recovered → nothing to do.
// A partial failure after canonical processing is finished by simply calling
// again: the plan resolves to 'annotate_only' and completes the annotation
// without reprocessing the pull.

import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver, assertSameCompany, assertDriverOwns } from './security/requireDriverAuth.js';
import {
  planRecovery,
  buildReplacementIncomingPacket,
  buildRecoveryAnnotation,
  type RecoveryInput,
  type RejectedRecord,
  type RecoveryRejectCode,
} from './recoverRejectedPull.js';

const REJECT_CODE_TO_HTTPS: Record<RecoveryRejectCode, httpsV2.FunctionsErrorCode> = {
  INVALID_ARGUMENT: 'invalid-argument',
  REJECTED_RECORD_NOT_FOUND: 'not-found',
  NOT_A_PULL: 'failed-precondition',
  CROSS_COMPANY: 'permission-denied',
  NOT_OWNER: 'permission-denied',
  WELL_MISMATCH: 'failed-precondition',
  MALFORMED_REPLACEMENT_TIME: 'invalid-argument',
  REPLACEMENT_NOT_NEWER: 'failed-precondition',
  REPLACEMENT_ID_CONFLICT: 'already-exists',
  RECOVERED_UNDER_DIFFERENT_ID: 'already-exists',
};

/** Current watermark (lastPullDateTimeUTC) for a well, or null. */
async function readWatermark(db: admin.database.Database, wellName: string): Promise<string | null> {
  const snap = await db.ref('packets/outgoing').orderByChild('wellName').equalTo(wellName).once('value');
  let watermark: string | null = null;
  snap.forEach((child) => {
    const v = child.val() as { lastPullDateTimeUTC?: string } | null;
    const t = v && typeof v.lastPullDateTimeUTC === 'string' ? v.lastPullDateTimeUTC : null;
    if (t && (!watermark || new Date(t).getTime() > new Date(watermark).getTime())) watermark = t;
  });
  return watermark;
}

export const recoverRejectedPull = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB' },
  async (request) => {
    const driver = await requireSecureDriver(request);

    const body = (request.data || {}) as Partial<RecoveryInput>;
    const rejectedPacketId = typeof body.rejectedPacketId === 'string' ? body.rejectedPacketId.trim() : '';
    const replacementPacketId = typeof body.replacementPacketId === 'string' ? body.replacementPacketId.trim() : '';
    if (!rejectedPacketId || !replacementPacketId || !body.corrected) {
      throw new httpsV2.HttpsError('invalid-argument', 'rejectedPacketId, replacementPacketId, corrected required');
    }

    const db = admin.database();

    // Read the preserved rejected record first — it carries the well/company/
    // driver identity we validate against and recover from.
    const rejectedSnap = await db.ref(`packets/rejected/${rejectedPacketId}`).once('value');
    const rejected = (rejectedSnap.val() as RejectedRecord | null) ?? null;

    // Company/driver ownership gate (defence-in-depth; planRecovery re-checks).
    if (rejected) {
      const pkt = (rejected.packet ?? {}) as Record<string, unknown>;
      assertSameCompany(driver.companyId, typeof pkt.companyId === 'string' ? pkt.companyId : undefined);
      assertDriverOwns(driver.driverId, typeof pkt.driverId === 'string' ? pkt.driverId : undefined);
    }

    const wellName =
      (rejected?.packet && typeof rejected.packet.wellName === 'string' && rejected.packet.wellName) ||
      (typeof rejected?.wellName === 'string' ? rejected.wellName : '') || '';

    const [replacementSnap, watermark] = await Promise.all([
      db.ref(`packets/processed/${replacementPacketId}`).once('value'),
      wellName ? readWatermark(db, wellName) : Promise.resolve<string | null>(null),
    ]);

    const input: RecoveryInput = {
      rejectedPacketId,
      replacementPacketId,
      corrected: body.corrected,
      caller: { companyId: driver.companyId, driverId: driver.driverId },
    };

    const plan = planRecovery(input, {
      rejected,
      replacementProcessed: (replacementSnap.val() as Record<string, unknown> | null) ?? null,
      watermarkDateTimeUTC: watermark,
      nowMs: Date.now(),
    });

    if (plan.action === 'reject') {
      throw new httpsV2.HttpsError(REJECT_CODE_TO_HTTPS[plan.code], `${plan.code}: ${plan.message}`);
    }

    if (plan.action === 'noop_complete') {
      return { status: 'already_recovered', replacementPacketId, rejectedPacketId };
    }

    if (plan.action === 'annotate_only') {
      // Replacement already processed — finish ONLY the recovery annotation.
      await db.ref().update(buildRecoveryAnnotation(input, new Date().toISOString()));
      console.log(`[recoverRejectedPull] annotated ${rejectedPacketId} recovered by ${replacementPacketId}`);
      return { status: 'recovered', replacementPacketId, rejectedPacketId };
    }

    // plan.action === 'process' — submit the replacement to the canonical
    // processor. Annotation happens on a follow-up call once processed exists.
    const packet = buildReplacementIncomingPacket(input, rejected as RejectedRecord);
    packet.ingestedBy = `recovery_${driver.driverId}`.slice(0, 128);
    packet.ingestedAt = admin.database.ServerValue.TIMESTAMP as unknown as number;
    await db.ref(`packets/incoming/${replacementPacketId}`).set(packet);
    console.log(`[recoverRejectedPull] submitted replacement ${replacementPacketId} for ${rejectedPacketId} (well=${wellName})`);
    return { status: 'processing_submitted', replacementPacketId, rejectedPacketId };
  },
);
