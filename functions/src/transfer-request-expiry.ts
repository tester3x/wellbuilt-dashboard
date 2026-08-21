// transfer-request-expiry.ts
//
// 2026-05-12 — Scheduled TTL expiry for transfer_requests.
//
// Why this exists:
//   The new transfer_requests model (commit f5d8413) was Phase 0+1+2+3
//   bundled and explicitly deferred TTL enforcement. Every pending
//   request has ttlExpiresAt set at create time (TRANSFER_REQUEST_TTL_HOURS
//   = 4 hours, in wellbuilt-tickets/utils/transferRequests.ts:39), but
//   no cron flips status to 'expired' when the deadline passes. A
//   driver who taps Transfer and never gets a receiver response leaves
//   the request pending forever, with two operational consequences:
//
//   1. Sender's source invoice stays in `lockedForTransfer:true` state —
//      cannot be closed/cancelled via normal UI until manually resolved.
//   2. Pending offer accumulates in dashboard surfaces (when those land)
//      and in the receiver's TransferOfferModal subscription.
//
//   No data loss, no billing impact, but operational hygiene degrades
//   day by day. This CF closes the gap.
//
// Operational definition:
//   "Expired" = client TTL elapsed without resolution. The TTL value is
//   chosen at create time (currently 4h, configurable in WB T). This
//   cron does NOT pick a TTL value of its own — it just enforces the
//   one already stamped on the document.
//
// Atomic shape: same as `resolveTransferRequest` callable (waterticket
// codebase) but with terminalBy='system' and terminalReason='ttl_expired'.
// Sender's invoice gets the same activeTransferRequestId / lockedForTransfer
// clear. Source ownership unchanged — TTL never changes ownership, only
// terminates the offer.
//
// Loop safety:
//   Single status-transition (pending -> expired), one-shot. Idempotent
//   re-run picks up any pending request whose ttlExpiresAt is in the
//   past, including ones missed by an earlier cron failure.
//
// Schedule: every 15 minutes. Trade-off: short enough that a stale
// offer doesn't linger more than a quarter-hour past TTL; long enough
// that the cron doesn't add load when no transfers are in flight.

import * as functionsV1 from 'firebase-functions/v1';
import * as functionsV2 from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { logCanonicalDiag } from './canonical-jobs/diag';

const MAX_EXPIRE_PER_RUN = 100;

interface ExpiryResult {
  processed: number;
  expired: Array<{ requestId: string; sourceInvoiceDocId: string }>;
  errors: Array<{ requestId: string; error: string }>;
  skipped: Array<{ requestId: string; reason: string }>;
}

/**
 * Core expiry routine. Exported so admin tooling can invoke ad-hoc.
 *
 * For each pending transfer_request whose ttlExpiresAt has passed:
 *   - request: status -> 'expired', terminalAt/By/Reason set
 *   - source invoice: clear activeTransferRequestId + lockedForTransfer
 *   - canonical_jobs (if linked): append 'transfer_expired' event
 *
 * Writes are batched per request (3 docs each) for atomicity. Multiple
 * requests are processed sequentially to avoid a flood of batched writes
 * if many TTLs hit at once (typical: 0-5 per run).
 */
export async function runTransferRequestExpiry(
  maxToExpire: number = MAX_EXPIRE_PER_RUN,
): Promise<ExpiryResult> {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  const result: ExpiryResult = {
    processed: 0,
    expired: [],
    errors: [],
    skipped: [],
  };

  let snap;
  try {
    snap = await db
      .collection('transfer_requests')
      .where('status', '==', 'pending')
      .where('ttlExpiresAt', '<=', now)
      .orderBy('ttlExpiresAt', 'asc')
      .limit(maxToExpire)
      .get();
  } catch (err: unknown) {
    console.error(
      '[transfer-request-expiry] query failed (composite index missing?):',
      err instanceof Error ? err.message : String(err),
    );
    result.errors.push({
      requestId: '(query)',
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const reqDoc of snap.docs) {
    result.processed++;
    const requestId = reqDoc.id;
    const reqData = reqDoc.data();

    try {
      const sourceInvoiceDocId = reqData.sourceInvoiceDocId as string | null;
      if (!sourceInvoiceDocId) {
        result.skipped.push({ requestId, reason: 'no_source_invoice_doc_id' });
        continue;
      }

      // Defensive re-read inside batch: someone may have raced us (driver
      // tapped Accept just as TTL fired). The status check at write-time
      // is the safety. Firestore doesn't support conditional updates in a
      // simple batch; we use a transaction for read-then-write safety.
      const expireOutcome = await db.runTransaction(async (tx) => {
        const reqSnap = await tx.get(reqDoc.ref);
        if (!reqSnap.exists) return { ok: false as const, reason: 'request_deleted_mid_tx' };
        const currentReq = reqSnap.data();
        if (!currentReq) return { ok: false as const, reason: 'request_data_empty' };
        if (currentReq.status !== 'pending') {
          return { ok: false as const, reason: `status_already_${currentReq.status}` };
        }

        // Mark request expired
        tx.update(reqDoc.ref, {
          status: 'expired',
          terminalAt: admin.firestore.FieldValue.serverTimestamp(),
          terminalBy: 'system',
          terminalReason: 'ttl_expired',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Clear sender's invoice lock (idempotent — if already cleared,
        // no harm; if still set, this releases it).
        const invRef = db.collection('invoices').doc(sourceInvoiceDocId);
        const invSnap = await tx.get(invRef);
        if (invSnap.exists) {
          const invData = invSnap.data();
          // Only clear if THIS request is the active lock. Defensive: if
          // another (newer) transfer request has taken over the lock,
          // don't trample it.
          if (invData?.activeTransferRequestId === requestId) {
            tx.update(invRef, {
              activeTransferRequestId: null,
              lockedForTransfer: false,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }

        return { ok: true as const };
      });

      if (!expireOutcome.ok) {
        result.skipped.push({ requestId, reason: expireOutcome.reason });
        continue;
      }

      // Canonical event append (best-effort, non-blocking on failure).
      const packetIdFromReq =
        (reqData.sourcePacketId as string | null) ||
        (reqData.canonicalJobId as string | null) ||
        null;
      if (packetIdFromReq) {
        try {
          await db
            .collection('canonical_jobs')
            .doc(packetIdFromReq)
            .update({
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              events: admin.firestore.FieldValue.arrayUnion({
                type: 'transfer_expired',
                timestamp: Date.now(),
                actorDriverHash: null,
                actorSource: 'cf',
                notes: 'ttl_expired',
                extra: {
                  transferRequestId: requestId,
                  sourceInvoiceDocId,
                  terminalBy: 'system',
                  terminalReason: 'ttl_expired',
                },
              }),
            });
        } catch (cjErr: unknown) {
          // Never block expiry on canonical-jobs patch failures.
          console.warn(
            `[transfer-request-expiry] canonical_jobs patch failed for ${requestId} (non-fatal):`,
            cjErr instanceof Error ? cjErr.message : String(cjErr),
          );
        }
      }

      result.expired.push({ requestId, sourceInvoiceDocId });

      // Per-request observability log
      await logCanonicalDiag({
        level: 'info',
        event: 'transfer.expired_by_ttl',
        source: 'cf',
        reason: 'ttl_expired',
        payload: {
          transferRequestId: requestId,
          sourceInvoiceDocId,
          fromDriverHash: (reqData.fromDriverHash as string | null) || null,
          toDriverHash: (reqData.toDriverHash as string | null) || null,
          wellName: (reqData.wellName as string | null) || null,
          totalBBL: (reqData.totalBBL as number | undefined) ?? null,
        },
      });
    } catch (err: unknown) {
      result.errors.push({
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        `[transfer-request-expiry] error processing ${requestId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Summary observability log — only emit if there was anything to do.
  if (result.processed > 0 || result.errors.length > 0) {
    await logCanonicalDiag({
      level: result.errors.length > 0 ? 'warn' : 'info',
      event: 'transfer.expiry_run_complete',
      source: 'cf',
      reason: `processed=${result.processed} expired=${result.expired.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
      payload: {
        processed: result.processed,
        expired: result.expired.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
      },
    });
  }

  return result;
}

/**
 * Scheduled expiry — every 15 minutes.
 */
export const transferRequestExpiry = functionsV2.onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'America/Chicago',
    timeoutSeconds: 300,
    retryCount: 0,
  },
  async (_event) => {
    try {
      const result = await runTransferRequestExpiry();
      if (result.processed > 0) {
        console.log(
          `[transfer-request-expiry] processed=${result.processed} expired=${result.expired.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
        );
      }
    } catch (err: unknown) {
      console.error(
        '[transfer-request-expiry] outer catch:',
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : '',
      );
    }
  },
);

/**
 * Admin callable — run expiry on demand. Returns the result inline.
 * Useful for clearing a backlog after deploy or when debugging.
 * Auth: signed-in user required.
 */
export const runTransferRequestExpiryOnDemand = functionsV1.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functionsV1.https.HttpsError('unauthenticated', 'Sign-in required');
    }
    const { requirePlatformAdmin } = await import('./security/adminAuth');
    await requirePlatformAdmin(context.auth.uid, context.auth.token as Record<string, unknown> | undefined);
    const maxToExpire =
      typeof data?.maxToExpire === 'number' ? data.maxToExpire : MAX_EXPIRE_PER_RUN;
    return await runTransferRequestExpiry(maxToExpire);
  },
);
