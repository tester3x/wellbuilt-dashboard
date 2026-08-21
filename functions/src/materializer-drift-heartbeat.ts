// materializer-drift-heartbeat.ts
//
// 2026-05-12 — Drift detection for the transfer ticket materializer.
//
// Why this exists:
//   `materializeTransferredTicket` (transfer-ticket-materializer.ts) is now
//   load-bearing infrastructure: receiver-side transferred-closed invoices
//   depend on it to synthesize a tickets/{N} doc so dashboard / billing /
//   payroll can see them. If the CF silently stops firing (deploy regression,
//   trigger config drift, Firestore quota, swallowed error), transferred
//   work closes in WB T, drivers see it in their History, but Dashboard,
//   billing, and payroll go blind to it.
//
//   That failure mode is QUIET — there's no conflict to detect, no error to
//   surface. The 18453 boomerang double-BBL bug was loud because the dedup
//   gate created an audit event; a missing materialization creates no event
//   at all.
//
//   This heartbeat is the cheap insurance: scan recent closed transferred
//   invoices, detect drift, write a report doc + observability log. It does
//   NOT auto-heal — recovery is via the existing `backfillTransferredTickets`
//   callable, gated to admin action.
//
// What "drift" means here (three categories):
//
//   1. missing_materialized_ticket — invoice is closed + transferSourceDocId
//      set + pendingTicketNumber set, but no tickets/transfer_{invoiceId}
//      exists AND no real submitTicket-created tickets/{N} doc with that
//      ticketNumber exists either. Materialization never ran for this row,
//      OR ran and failed silently, OR was deleted.
//
//   2. invoice_tickets_empty — invoice.tickets[] does NOT include
//      pendingTicketNumber, so billing / payroll won't find the work
//      through the invoice anchor. Materializer's arrayUnion patch failed
//      or got reverted.
//
//   3. canonical_link_missing — invoice has packetId set but the
//      corresponding canonical_jobs/{packetId} doc has ticketDocId=null,
//      so the linkage layer doesn't know about the materialized ticket.
//
// Categories overlap. A single drifted invoice may hit 1+2+3. The report
// counts categories independently and lists invoiceIds per category.
//
// Output:
//   materializer_drift_reports/{YYYY-MM-DD}  — one report per scan day,
//     overwritten on re-run within the same day (idempotent).
//   materializer_drift_reports/_heartbeat    — last-run timestamp + status,
//     useful for answering "is the heartbeat itself alive."
//   wb_diagnostics entries — one per drifted invoice (capped at 50/run),
//     plus one summary entry per run.
//
// Schedule: daily at 03:15 (avoids 03:00 cleanupExpiredPhotos). Drift is
// cumulative not urgent — daily cadence is enough.
//
// Safety:
//   - Read-only over invoices/, tickets/, canonical_jobs/. No writes to
//     business data. Only writes to materializer_drift_reports/ and
//     wb_diagnostics/.
//   - 500-invoice scan cap. Typical day is dozens of closed transferred
//     invoices; cap is defensive.
//   - Never throws — drift detection must not break other scheduled work.
//   - No auto-heal. Heal action requires explicit admin invocation.

import * as functionsV1 from 'firebase-functions/v1';
import * as functionsV2 from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { logCanonicalDiag } from './canonical-jobs/diag';

const SCAN_WINDOW_HOURS = 25; // 1-hour overlap on the 24h day
const MAX_SCAN = 500;
const MAX_DIAG_PER_RUN = 50; // cap per-invoice diag emissions

interface DriftedInvoice {
  invoiceId: string;
  pendingTicketNumber: string;
  packetId: string | null;
  closedAt: string | null;
  transferredFrom: string | null;
  transferredTo: string | null;
  totalBBL: number | null;
  categories: string[]; // subset of: missing_materialized_ticket, invoice_tickets_empty, canonical_link_missing
}

interface DriftReport {
  generatedAt: admin.firestore.FieldValue | admin.firestore.Timestamp;
  scanWindowHours: number;
  scanned: number;
  drifted: number;
  categoryCounts: {
    missing_materialized_ticket: number;
    invoice_tickets_empty: number;
    canonical_link_missing: number;
  };
  driftedInvoices: DriftedInvoice[]; // capped
  truncated: boolean;
  errors: Array<{ invoiceId: string; error: string }>;
}

/**
 * Core drift detection routine. Exported so admin tooling can run it
 * ad-hoc (e.g. via a callable wrapper) without waiting for the cron.
 *
 * Returns the full report. Writes to materializer_drift_reports/ are
 * the caller's responsibility.
 */
export async function runMaterializerDriftScan(
  windowHours: number = SCAN_WINDOW_HOURS,
  maxScan: number = MAX_SCAN,
): Promise<DriftReport> {
  const db = admin.firestore();
  const now = Date.now();
  const threshold = admin.firestore.Timestamp.fromMillis(now - windowHours * 60 * 60 * 1000);

  const report: DriftReport = {
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    scanWindowHours: windowHours,
    scanned: 0,
    drifted: 0,
    categoryCounts: {
      missing_materialized_ticket: 0,
      invoice_tickets_empty: 0,
      canonical_link_missing: 0,
    },
    driftedInvoices: [],
    truncated: false,
    errors: [],
  };

  // Query: closed transferred invoices in the scan window.
  //
  // Single inequality per Firestore rules (closedAt). Client-side filter
  // for transferSourceDocId, pendingTicketNumber gates. This matches the
  // existing backfillTransferredTickets query shape and uses indexes
  // already exercised by the materializer.
  let snap;
  try {
    snap = await db
      .collection('invoices')
      .where('status', '==', 'closed')
      .where('closedAt', '>=', threshold)
      .orderBy('closedAt', 'desc')
      .limit(maxScan)
      .get();
  } catch (err: unknown) {
    // Index missing? Log and bail — don't break other scheduled work.
    console.error(
      '[materializer-drift-heartbeat] query failed:',
      err instanceof Error ? err.message : String(err),
    );
    report.errors.push({
      invoiceId: '(query)',
      error: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  if (snap.size === maxScan) report.truncated = true;

  for (const doc of snap.docs) {
    const data = doc.data();
    const invoiceId = doc.id;

    // Gate: only receiver-side transferred invoices with a reserved number.
    if (!data.transferSourceDocId) continue;
    if (!data.pendingTicketNumber) continue;

    report.scanned++;
    const pendingTicketNumber = String(data.pendingTicketNumber);
    const packetId: string | null =
      (data.packetId as string | null) || (data.canonicalJobId as string | null) || null;

    try {
      const categories: string[] = [];

      // ── Category 1: missing materialized ticket ─────────────────────
      // Check tickets/transfer_{invoiceId}. If absent, check whether a
      // real submitTicket-created doc with the same ticketNumber exists
      // (boomerang case — see transfer-ticket-materializer.ts dedup gate).
      const materializedDocId = `transfer_${invoiceId}`;
      const matSnap = await db.collection('tickets').doc(materializedDocId).get();
      let hasMaterializedOrReal = matSnap.exists;
      if (!hasMaterializedOrReal) {
        const realQ = await db
          .collection('tickets')
          .where('ticketNumber', '==', pendingTicketNumber)
          .where('invoiceDocId', '==', invoiceId)
          .limit(1)
          .get();
        hasMaterializedOrReal = !realQ.empty;
      }
      if (!hasMaterializedOrReal) {
        categories.push('missing_materialized_ticket');
        report.categoryCounts.missing_materialized_ticket++;
      }

      // ── Category 2: invoice.tickets[] does not include pendingTicketNumber ─
      const ticketsArr = Array.isArray(data.tickets) ? data.tickets : [];
      if (!ticketsArr.includes(pendingTicketNumber)) {
        categories.push('invoice_tickets_empty');
        report.categoryCounts.invoice_tickets_empty++;
      }

      // ── Category 3: canonical_jobs missing ticketDocId link ─────────
      if (packetId) {
        const cjSnap = await db.collection('canonical_jobs').doc(packetId).get();
        if (cjSnap.exists) {
          const cj = cjSnap.data();
          if (!cj?.ticketDocId) {
            categories.push('canonical_link_missing');
            report.categoryCounts.canonical_link_missing++;
          }
        }
        // If canonical_jobs doc itself is missing, that's a different layer
        // problem (canonical_jobs Phase 1 didn't write) — not flagged here
        // to keep this heartbeat focused on materializer drift specifically.
      }

      if (categories.length > 0) {
        report.drifted++;
        if (report.driftedInvoices.length < MAX_DIAG_PER_RUN) {
          const closedAtTs = data.closedAt as admin.firestore.Timestamp | null;
          report.driftedInvoices.push({
            invoiceId,
            pendingTicketNumber,
            packetId,
            closedAt: closedAtTs?.toDate?.()?.toISOString() || null,
            transferredFrom: (data.transferredFrom as string | null) || null,
            transferredTo: (data.transferredTo as string | null) || null,
            totalBBL: (data.totalBBL as number | undefined) ?? null,
            categories,
          });
        }
      }
    } catch (err: unknown) {
      report.errors.push({
        invoiceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

/**
 * Emit per-invoice + summary diag events for a completed scan.
 * Called by the scheduler and (optionally) ad-hoc callable wrappers.
 */
async function emitDriftDiagnostics(report: DriftReport): Promise<void> {
  // Per-invoice rows (capped already in report.driftedInvoices via MAX_DIAG_PER_RUN)
  for (const di of report.driftedInvoices) {
    await logCanonicalDiag({
      level: 'warn',
      event: 'materializer.drift_detected',
      source: 'cf',
      reason: di.categories.join('+'),
      payload: {
        invoiceId: di.invoiceId,
        pendingTicketNumber: di.pendingTicketNumber,
        packetId: di.packetId,
        closedAt: di.closedAt,
        transferredFrom: di.transferredFrom,
        transferredTo: di.transferredTo,
        totalBBL: di.totalBBL,
        categories: di.categories.join(','),
      },
    });
  }

  // Summary row
  await logCanonicalDiag({
    level: report.drifted > 0 ? 'warn' : 'info',
    event: 'materializer.drift_scan_complete',
    source: 'cf',
    reason: report.drifted > 0 ? `${report.drifted} drifted of ${report.scanned} scanned` : 'no drift',
    payload: {
      scanned: report.scanned,
      drifted: report.drifted,
      scanWindowHours: report.scanWindowHours,
      missing_materialized_ticket: report.categoryCounts.missing_materialized_ticket,
      invoice_tickets_empty: report.categoryCounts.invoice_tickets_empty,
      canonical_link_missing: report.categoryCounts.canonical_link_missing,
      truncated: report.truncated,
      errorCount: report.errors.length,
    },
  });
}

/**
 * Persist the report doc + heartbeat marker. Idempotent — overwrites
 * the per-day report on re-run within the same UTC day.
 */
async function persistReport(report: DriftReport): Promise<string> {
  const db = admin.firestore();
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const reportId = `${y}-${m}-${day}`;

  await db
    .collection('materializer_drift_reports')
    .doc(reportId)
    .set(report as unknown as Record<string, unknown>);

  // Heartbeat marker — single doc, always updated to last-run state.
  await db.collection('materializer_drift_reports').doc('_heartbeat').set(
    {
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      lastReportId: reportId,
      lastScanned: report.scanned,
      lastDrifted: report.drifted,
      lastErrorCount: report.errors.length,
    },
    { merge: true },
  );

  return reportId;
}

/**
 * Scheduled drift heartbeat — runs daily at 03:15 UTC.
 *
 * Sequence:
 *   1. Scan closed transferred invoices in the last 25 hours.
 *   2. For each, check the three drift categories.
 *   3. Write per-day report doc + heartbeat marker.
 *   4. Emit wb_diagnostics rows (per-invoice + summary).
 */
export const materializerDriftHeartbeat = functionsV2.onSchedule(
  {
    schedule: 'every day 03:15',
    timeZone: 'America/Chicago',
    timeoutSeconds: 540,
    retryCount: 0, // Drift is observability — re-running on failure isn't critical
  },
  async (_event) => {
    try {
      console.log('[materializer-drift-heartbeat] starting daily scan...');
      const report = await runMaterializerDriftScan();
      const reportId = await persistReport(report);
      await emitDriftDiagnostics(report);
      console.log(
        `[materializer-drift-heartbeat] complete: report=${reportId} scanned=${report.scanned} drifted=${report.drifted} errors=${report.errors.length}`,
      );
    } catch (err: unknown) {
      // Never throw — would trigger a retry we don't want.
      console.error(
        '[materializer-drift-heartbeat] outer catch:',
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : '',
      );
    }
  },
);

/**
 * Admin callable — run drift scan on demand. Returns the full report
 * inline so admins can see drift without waiting for the next scheduled run.
 *
 * Does NOT auto-heal. To heal drifted invoices, call
 * `backfillTransferredTickets({ invoiceIds: [...] })` with the
 * invoiceIds reported here.
 *
 * Auth: callable context.auth required. No role check at the callable
 * layer because this is read-only and dashboard is the only consumer.
 * Dashboard already gates admin tools by capability — wire the dashboard
 * button to the appropriate capability check before exposing.
 */
export const runMaterializerDriftScanOnDemand = functionsV1.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functionsV1.https.HttpsError('unauthenticated', 'Sign-in required');
    }
    const { requirePlatformAdmin } = await import('./security/adminAuth');
    await requirePlatformAdmin(context.auth.uid, context.auth.token as Record<string, unknown> | undefined);
    const windowHours = typeof data?.windowHours === 'number' ? data.windowHours : SCAN_WINDOW_HOURS;
    const maxScan = typeof data?.maxScan === 'number' ? data.maxScan : MAX_SCAN;
    const persist = !!data?.persist;

    const report = await runMaterializerDriftScan(windowHours, maxScan);
    if (persist) {
      await persistReport(report);
      await emitDriftDiagnostics(report);
    }
    return report;
  },
);
