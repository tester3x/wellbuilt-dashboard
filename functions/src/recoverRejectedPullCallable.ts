// recoverRejectedPullCallable.ts — authenticated, company-scoped onCall wrapper
// around the pure recovery runner in recoverRejectedPull.ts.
//
// Auth: authenticated driver (claims) who owns the rejected pull (same company +
// driver). All decisions come from planRecovery/executeRecovery; this wrapper
// only supplies the real transactional read/write/claim surface and maps
// outcomes to callable results / HttpsErrors.
//
// Single-winner: an atomic transaction on packets/rejected/<id>/recoveryClaim
// (a SIBLING of the preserved .packet) guarantees at most one replacement id can
// enter processing. Incoming is written only-if-absent (never overwritten). The
// bounded runner takes the second (annotate) step as soon as the canonical
// processor writes the processed receipt, so recovery cannot stall.

import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver, assertSameCompany, assertDriverOwns } from './security/requireDriverAuth.js';
import {
  executeRecovery,
  planClaim,
  type RecoveryIO,
  type RecoveryInput,
  type RecoveryState,
  type RejectedRecord,
  type ClaimResult,
  type RecoveryRejectCode,
} from './recoverRejectedPull.js';

import { resolveAuthoritativeWellConfig } from './security/resolveAuthoritativeWellConfig.js';
import { outgoingCompositeKey } from './security/outgoingCompositeKey.js';
import { canonicalWellId } from './security/dashboardCatalogProjection.js';

const REJECT_CODE_TO_HTTPS: Record<RecoveryRejectCode, httpsV2.FunctionsErrorCode> = {
  INVALID_ARGUMENT: 'invalid-argument',
  REJECTED_RECORD_NOT_FOUND: 'not-found',
  REJECTION_NOT_RECOVERABLE: 'failed-precondition',
  NOT_A_PULL: 'failed-precondition',
  CROSS_COMPANY: 'permission-denied',
  NOT_OWNER: 'permission-denied',
  WELL_MISMATCH: 'failed-precondition',
  MALFORMED_REPLACEMENT_TIME: 'invalid-argument',
  REPLACEMENT_NOT_NEWER: 'failed-precondition',
  REPLACEMENT_ID_CONFLICT: 'already-exists',
  REPLACEMENT_REJECTED: 'failed-precondition',
  RECOVERED_UNDER_DIFFERENT_ID: 'already-exists',
};

async function readCanonicalWatermark(
  db: admin.database.Database,
  companyId: string,
  wellId: string,
): Promise<string | null> {
  const compositeKey = outgoingCompositeKey(companyId, wellId);
  const snap = await db.ref(`packets/outgoing/${compositeKey}`).once('value');
  if (!snap.exists()) return null;
  const row = (snap.val() || {}) as Record<string, unknown>;
  const rowCompany = typeof row.companyId === 'string' ? row.companyId.trim() : '';
  const rowWellId = canonicalWellId(row);
  if (rowCompany !== companyId || rowWellId !== wellId) {
    return null;
  }
  const t = typeof row.lastPullDateTimeUTC === 'string'
    ? row.lastPullDateTimeUTC
    : (typeof row.timestampUTC === 'string' ? row.timestampUTC : null);
  return t;
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

    // Ownership gate on the preserved record (defence-in-depth; planRecovery re-checks).
    const gateSnap = await db.ref(`packets/rejected/${rejectedPacketId}`).once('value');
    const gateRec = (gateSnap.val() as RejectedRecord | null) ?? null;
    if (gateRec) {
      const pkt = (gateRec.packet ?? {}) as Record<string, unknown>;
      assertSameCompany(driver.companyId, typeof pkt.companyId === 'string' ? pkt.companyId : undefined);
      assertDriverOwns(driver.driverId, typeof pkt.driverId === 'string' ? pkt.driverId : undefined);
    }

    const input: RecoveryInput = {
      rejectedPacketId,
      replacementPacketId,
      corrected: body.corrected,
      caller: { companyId: driver.companyId, driverId: driver.driverId },
    };

    const io: RecoveryIO = {
      async readState(): Promise<RecoveryState> {
        const rejectedSnap = await db.ref(`packets/rejected/${rejectedPacketId}`).once('value');
        const rejected = (rejectedSnap.val() as RejectedRecord | null) ?? null;
        const pkt = ((rejected?.packet ?? {}) as Record<string, unknown>);
        const wellName =
          (typeof pkt.wellName === 'string' && pkt.wellName.trim()) ||
          (typeof rejected?.wellName === 'string' ? rejected.wellName.trim() : '') || '';
        const candidateWellId = typeof pkt.wellId === 'string' ? pkt.wellId.trim() : '';

        let watermark: string | null = null;
        if (wellName && driver.companyId) {
          const resolvedBinding = await resolveAuthoritativeWellConfig({
            db,
            wellName,
            targetCompanyId: driver.companyId,
            candidateWellId,
          });
          if (resolvedBinding.ok) {
            watermark = await readCanonicalWatermark(
              db,
              resolvedBinding.resolved.companyId,
              resolvedBinding.resolved.wellId,
            );
          }
        }

        const [processedSnap, incomingSnap, replRejSnap] = await Promise.all([
          db.ref(`packets/processed/${replacementPacketId}`).once('value'),
          db.ref(`packets/incoming/${replacementPacketId}`).once('value'),
          db.ref(`packets/rejected/${replacementPacketId}`).once('value'),
        ]);
        return {
          rejected,
          replacementProcessed: (processedSnap.val() as Record<string, unknown> | null) ?? null,
          replacementIncoming: incomingSnap.exists(),
          replacementRejected: (replRejSnap.val() as Record<string, unknown> | null) ?? null,
          watermarkDateTimeUTC: watermark,
          nowMs: Date.now(),
        };
      },

      async claimRecovery(replId: string): Promise<ClaimResult> {
        const ref = db.ref(`packets/rejected/${rejectedPacketId}/recoveryClaim`);
        let conflictWith = '';
        const res = await ref.transaction((cur: { replacementPacketId?: string } | null) => {
          const d = planClaim(cur, replId, admin.database.ServerValue.TIMESTAMP);
          if (d.decision === 'acquire') return d.value;
          if (d.decision === 'matched') return cur; // keep — our own claim
          conflictWith = d.existingReplacementId;
          return; // abort — a different id already won
        });
        if (!res.committed && conflictWith && conflictWith !== replId) {
          return { ok: false, existingReplacementId: conflictWith };
        }
        return { ok: true };
      },

      async writeIncomingIfAbsent(replId: string, packet: Record<string, unknown>): Promise<'written' | 'exists'> {
        const ref = db.ref(`packets/incoming/${replId}`);
        const enriched = {
          ...packet,
          companyId: driver.companyId,
          ingestedBy: `recovery_${driver.driverId}`.slice(0, 128),
          ingestedAt: admin.database.ServerValue.TIMESTAMP,
        };
        let outcome: 'written' | 'exists' = 'exists';
        await ref.transaction((cur: unknown) => {
          if (cur == null) { outcome = 'written'; return enriched; }
          return cur; // never overwrite an in-flight incoming packet
        });
        return outcome;
      },

      async annotate(update: Record<string, unknown>): Promise<void> {
        await db.ref().update(update);
      },

      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    };

    const outcome = await executeRecovery(io, input, { maxAttempts: 6, backoffMs: 800 });

    if (outcome.status === 'rejected') {
      throw new httpsV2.HttpsError(REJECT_CODE_TO_HTTPS[outcome.code], `${outcome.code}: ${outcome.message}`);
    }
    if (outcome.status === 'conflict') {
      throw new httpsV2.HttpsError(REJECT_CODE_TO_HTTPS[outcome.code], `${outcome.code}: ${outcome.message}`);
    }
    // recovered | already_recovered | processing_submitted | replacement_rejected
    console.log(`[recoverRejectedPull] ${rejectedPacketId} → ${outcome.status} (${replacementPacketId})`);
    return { ...outcome, rejectedPacketId };
  },
);
