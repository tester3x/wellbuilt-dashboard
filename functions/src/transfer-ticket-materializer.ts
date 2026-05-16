// transfer-ticket-materializer.ts
//
// 2026-05-12 — Server-side ticket materialization for transferred-closed jobs.
//
// Why this exists:
//   WB T receiver-close path uses an EDIT-packet flow rather than submitTicket
//   (gated client-side at TicketModule.tsx:838 by `transferSrc`). The edit-packet
//   path (processEditRequest) writes ONLY to RTDB packets/processed, not Firestore.
//   So a transferred job that the receiver successfully closes has:
//     - invoices/{id} = status:'closed', driverState:'idle', closedAt set
//     - canonical_jobs/{packetId} = transfer_accepted event, but ticketDocId+
//       ticketNumber both null
//     - packets/processed/{packetId} = the receiver's final BBLs and tank level
//     - NO tickets/{N} doc anywhere
//
//   Dashboard's WB Tickets tab (src/lib/tickets.ts:126) queries collection(tickets)
//   directly with no fallback. Billing/payroll read invoice.tickets[] array which
//   is also empty. Net: transferred jobs are invisible across the dashboard.
//
// This CF fills the gap: on the EXACT moment a receiver-side transferred invoice
// flips to status:'closed', it materializes a canonical tickets/{N} doc and
// back-patches canonical_jobs.ticketDocId + ticketNumber. Dashboard's existing
// queries then see the row through the same path as normal-submitted tickets.
//
// Design constraints:
//   - Idempotent: deterministic docId 'transfer_{invoiceId}' so set() is safe to
//     repeat. Also pre-checks doc existence.
//   - Loop-safe: status-transition gate (before:!closed → after:closed) means the
//     follow-up invoice.update() below this won't re-fire materialization.
//   - No WB T changes: all data sourced from existing invoice/canonical_jobs/
//     transfer_request docs that WB T already writes.
//   - No new ticket-number allocation: ticketNumber comes from
//     invoice.pendingTicketNumber (the slot Driver 1 reserved during transfer
//     confirm). The 2026-05-11 slot-burn fix already retired this number from
//     Driver 1's local block.
//   - Does NOT touch packets/processed — preserves original pull dateTimeUTC.
//   - Does NOT call advanceTicketNumber / assignTicketBlock — no new slot burn.
//   - Does NOT depend on driver-app state — purely server-side.

import * as functionsV1 from 'firebase-functions/v1';
import * as admin from 'firebase-admin';

const fs = () => admin.firestore();

/**
 * Builds the canonical tickets/{N} doc from invoice + canonical_jobs + transfer_request.
 * Field mapping mirrors the shape of a normal submitTicket write (see WB T functions/src/index.ts:264)
 * so dashboard's existing mapTicketDoc handles it identically to a non-transferred ticket.
 */
async function buildMaterializedTicket(
  invoiceId: string,
  invoiceData: admin.firestore.DocumentData,
  pendingTicketNumber: number | string,
): Promise<Record<string, unknown>> {
  const now = admin.firestore.Timestamp.now();
  const db = fs();

  // Pull canonical_jobs for the merged packet view (driver, tank levels, dateTime).
  const packetId: string | null = (invoiceData.packetId as string | null)
    || (invoiceData.canonicalJobId as string | null)
    || null;
  let canonical: admin.firestore.DocumentData | null = null;
  if (packetId) {
    const cjSnap = await db.collection('canonical_jobs').doc(packetId).get();
    if (cjSnap.exists) canonical = cjSnap.data() || null;
  }

  // Pull transfer_request for sender attribution (in case invoice fields are sparse).
  let transferReq: admin.firestore.DocumentData | null = null;
  const transferRequestId: string | null = (invoiceData.activeTransferRequestId as string | null) || null;
  if (transferRequestId) {
    const trSnap = await db.collection('transfer_requests').doc(transferRequestId).get();
    if (trSnap.exists) transferReq = trSnap.data() || null;
  }

  // Resolve receipt date from closedAt or now.
  let dateStr = '';
  try {
    const closedTs = invoiceData.closedAt as admin.firestore.Timestamp | null;
    const d = closedTs?.toDate?.() || new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dateStr = `${m}/${day}/${d.getFullYear()}`;
  } catch {
    dateStr = '';
  }

  const ticketNumberStr = String(pendingTicketNumber);

  // formSnapshot carries the receiver's final form values at close time (top/bottom
  // gauge readings, hauledTo etc.). preTransferState carries pre-confirm snapshot.
  const formSnapshot = (invoiceData.formSnapshot as Record<string, string> | null) || {};
  const preTransferState = (invoiceData.preTransferState as Record<string, unknown> | null) || {};

  // Well name resolution — prefer LONG form (NDIC well name) over SHORT form (WB M).
  // The receiver's form-snapshot carries the long form (set by the form's NDIC
  // autocomplete during the original receiver session). invoice.wellName is the
  // short form WB M uses ("Gabriel 1"). Normal submitTicket-created tickets use
  // long form for both wellName and location fields (see 18448 reference).
  // Priority: formSnapshot.location > formSnapshot.wellName > invoiceData.wellLocation > invoiceData.wellName > canonical.wellName.
  // For ticket doc fields: wellName + location both use the long form
  // (matches normal submitTicket convention seen on 18448 reference doc).
  const wellName = (formSnapshot.location as string | null)
    || (formSnapshot.wellName as string | null)
    || (invoiceData.wellLocation as string | null)
    || (invoiceData.wellName as string | null)
    || (canonical?.wellName as string | null)
    || '';
  const hauledTo = (invoiceData.hauledTo as string | null)
    || (formSnapshot.hauledTo as string | null)
    || (canonical?.hauledTo as string | null)
    || '';

  const driverName = (invoiceData.driver as string | null)
    || (canonical?.driverName as string | null)
    || (transferReq?.toDriverName as string | null)
    || null;
  const driverHash = (invoiceData.driverHash as string | null)
    || (canonical?.driverHash as string | null)
    || (transferReq?.toDriverHash as string | null)
    || null;

  // 2026-05-15 forensic — receiver-close was emitting STALE bbls/qty.
  // Gabriel 2 case (ticket 18465): sender edited 140 → 120 before tapping
  // Transfer. formSnapshot.bbls = "120" and transfer_request.totalBBL = 120
  // both captured the edited value, but invoice.totalBBL stayed at 140 (the
  // accept-time snapshot). Materializer read invoice.totalBBL → emitted
  // ticket.bbls = "140". top/bottom were correct because they already
  // sourced from formSnapshot.
  //
  // Priority (formSnapshot is the only path the pre-transfer edit reliably
  // writes to; transfer_request.totalBBL is the same value captured one hop
  // downstream; invoice.totalBBL is the stale snapshot; canonical.bblsTaken
  // is the WB M pull packet from depart-pickup):
  //   1. invoice.formSnapshot.bbls  — edited final value
  //   2. transfer_request.totalBBL  — same edited value captured at xfer create
  //   3. invoice.totalBBL           — stale invoice-level snapshot
  //   4. canonical.bblsTaken        — WB M pull packet
  //   5. 0
  const parseNumericBbls = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  };
  const bblsNum = parseNumericBbls(formSnapshot.bbls)
    ?? parseNumericBbls(transferReq?.totalBBL)
    ?? parseNumericBbls(invoiceData.totalBBL)
    ?? parseNumericBbls(canonical?.bblsTaken)
    ?? 0;

  const doc: Record<string, unknown> = {
    // ─ Core identity ─
    ticketNumber: ticketNumberStr,
    invoiceNumber: invoiceData.invoiceNumber || null,
    date: dateStr,
    timestamp: now,
    createdAt: now,
    // materializedAt tags this doc as server-materialized for audit/distinguishing
    // from normal submitTicket creates. Dashboard ignores it.
    materializedAt: now,

    // ─ Well / location ─
    wellName,
    location: wellName,
    // 2026-05-15 forensic parity — receiver-materialized tickets were missing
    // operator/company/apiNo/legal/county/gps/notes/sourceName even though all of
    // those fields exist on the source invoice's formSnapshot. Source priority
    // per spec: invoice.formSnapshot → invoice top-level → null. Restores parity
    // with the normal close-path ticket schema so the dashboard "Company" column
    // and downstream renderers see transferred tickets identically.
    operator: (formSnapshot.operator as string)
      || (formSnapshot.operatorName as string)
      || (formSnapshot.fieldOperator as string)
      || invoiceData.operator
      || null,
    company: (formSnapshot.company as string)
      || (formSnapshot.fieldOperator as string)
      || (formSnapshot.operatorName as string)
      || (invoiceData.company as string)
      || invoiceData.operator
      || null,
    sourceName: (formSnapshot.sourceName as string)
      || (formSnapshot.location as string)
      || wellName
      || null,
    apiNo: (formSnapshot.apiNo as string) || (invoiceData.apiNo as string) || null,
    legalDesc: (formSnapshot.legalDesc as string) || (invoiceData.legalDesc as string) || null,
    county: (formSnapshot.county as string) || (invoiceData.county as string) || null,
    gpsLat: (formSnapshot.gpsLat as string) || (invoiceData.gpsLat as string) || null,
    gpsLng: (formSnapshot.gpsLng as string) || (invoiceData.gpsLng as string) || null,

    // ─ Disposal ─
    hauledTo,
    disposal: hauledTo,
    hauledToLat: invoiceData.hauledToLat ?? null,
    hauledToLng: invoiceData.hauledToLng ?? null,
    hauledToApiNo: (formSnapshot.hauledToApiNo as string)
      || (invoiceData.hauledToApiNo as string)
      || null,
    hauledToCounty: (formSnapshot.hauledToCounty as string)
      || (invoiceData.hauledToCounty as string)
      || null,
    hauledToLegalDesc: (formSnapshot.hauledToLegalDesc as string)
      || (invoiceData.hauledToLegalDesc as string)
      || null,
    // Notes — formSnapshot first, then invoice fallback, then empty.
    notes: (formSnapshot.notes as string) || (invoiceData.notes as string) || '',

    // ─ Driver (receiver) ─
    driver: driverName,
    driverId: driverHash,
    submittedBy: driverName || 'transferReceiver',
    truck: invoiceData.truckNumber || invoiceData.truck || null,
    trailer: invoiceData.trailer || null,

    // ─ Measurement ─
    bbls: String(bblsNum),
    qty: String(bblsNum),
    top: (formSnapshot.top as string) || (preTransferState.top as string) || '',
    bottom: (formSnapshot.bottom as string) || (preTransferState.bottom as string) || '',
    gaugeType: (formSnapshot.gaugeType as string) || '',

    // ─ Times ─
    startTime: invoiceData.startTime || null,
    stopTime: invoiceData.stopTime || null,
    finishedTime: invoiceData.finishedTime || null,
    timeIn: invoiceData.timeIn || null,
    timeOut: invoiceData.timeOut || null,

    // ─ Linkage ─
    invoiceDocId: invoiceId,
    packetId,
    canonicalJobId: invoiceData.canonicalJobId || packetId,
    dispatchId: invoiceData.dispatchId || null,
    companyId: invoiceData.companyId || canonical?.companyId || null,

    // ─ Transfer audit metadata (distinguishes materialized tickets from normal) ─
    transferredFrom: invoiceData.transferredFrom || transferReq?.fromDriverName || null,
    transferredFromHash: invoiceData.transferredFromHash || transferReq?.fromDriverHash || null,
    transferredTo: invoiceData.transferredTo || transferReq?.toDriverName || driverName,
    transferredToHash: invoiceData.transferredToHash || transferReq?.toDriverHash || driverHash,
    transferredAt: invoiceData.transferredAt || null,
    transferRequestId,
    transferSourceDocId: invoiceData.transferSourceDocId,

    // ─ Origin marker (distinguishes from submitTicket-created docs) ─
    source: 'transferReceiverClose',

    // ─ Original pull metadata — useful for AFR / billing reconciliation ─
    originalPullDateTimeUTC: (canonical?.dateTimeUTC as string | null) || null,

    // ─ Package fields mirrored from submitTicket defaults so downstream renderers don't choke ─
    type: invoiceData.commodityType || 'Production Water',
    packageId: invoiceData.packageId || 'water-hauling',
  };

  // Strip undefined keys (Firestore rejects them).
  for (const k of Object.keys(doc)) {
    if (doc[k] === undefined) delete doc[k];
  }

  return doc;
}

/**
 * Core materialization routine. Exported so the backfill script can invoke it
 * for already-closed invoices that pre-date this trigger.
 *
 * Returns:
 *   { materialized: true, docId } — wrote a new tickets/ doc
 *   { materialized: false, skipReason } — skipped (already exists, gates failed, etc.)
 */
export async function materializeTransferredTicketForInvoice(
  invoiceId: string,
  invoiceData?: admin.firestore.DocumentData,
): Promise<{ materialized: boolean; docId?: string; skipReason?: string; ticketNumber?: string; packetId?: string | null }> {
  const db = fs();

  // Load invoice if not provided
  let data = invoiceData;
  if (!data) {
    const snap = await db.collection('invoices').doc(invoiceId).get();
    if (!snap.exists) return { materialized: false, skipReason: 'invoice_not_found' };
    data = snap.data();
  }
  if (!data) return { materialized: false, skipReason: 'invoice_empty' };

  // Gate: must be closed
  if (data.status !== 'closed') return { materialized: false, skipReason: `status_not_closed (${data.status})` };

  // Gate: must be a receiver-side transferred job
  if (!data.transferSourceDocId) return { materialized: false, skipReason: 'not_transfer_receiver' };

  // Gate: must have reserved ticket number
  const pendingTicketNumber = data.pendingTicketNumber;
  if (pendingTicketNumber === undefined || pendingTicketNumber === null || pendingTicketNumber === '') {
    return { materialized: false, skipReason: 'no_pending_ticket_number' };
  }

  const ticketNumberStr = String(pendingTicketNumber);
  const materializedDocId = `transfer_${invoiceId}`;

  // ── Dedup gate 1: existing submitTicket-created doc ────────────────────
  // 2026-05-12 — 18453 multi-hop transfer double-BBL bug.
  //
  // Scenario: TabletS10 → MikeS24 → TabletS10 (boomerang). When the
  // original sender receives its OWN job back via transfer, the
  // transferSourceDocId gate in TicketModule.tsx:838 sometimes fails to
  // fire at receiver-close (stale AsyncStorage state from when the
  // sender originally owned this invoice). submitTicket runs, creates
  // tickets/{auto-id}, linkTicket adds 100 to invoice.totalBBL — which
  // was already 100 from the receiver-hydrate — bumping it to 200.
  // Then THIS trigger fires (because Firestore invoice still has
  // transferSourceDocId + status=closed) and materializes a SECOND
  // ticket doc with bbls=200 (sourced from the inflated invoice.totalBBL).
  //
  // Net: two tickets/* docs with same ticketNumber. Billing/payroll
  // read the materialized one (bbls=200) → drivers paid 2× for one
  // physical load. This violates the canonical rule that "transfers
  // change custody, transfers must NOT add BBLs."
  //
  // Fix: if invoice.tickets[] already contains pendingTicketNumber,
  // submitTicket already created a ticket for this invoice. Skip
  // materialization. Back-patch canonical_jobs.ticketDocId to the
  // existing doc (so downstream queries still resolve). Idempotent.
  if (Array.isArray(data.tickets) && data.tickets.includes(ticketNumberStr)) {
    let existingDocId: string | null = null;
    if (Array.isArray(data.ticketSummaries)) {
      // Prefer the non-materialized summary (real submitTicket doc).
      const realSummary = data.ticketSummaries.find(
        (ts: { ticketNumber?: string; docId?: string }) =>
          String(ts?.ticketNumber) === ticketNumberStr &&
          ts?.docId &&
          !ts.docId.startsWith('transfer_'),
      );
      if (realSummary?.docId) existingDocId = realSummary.docId;
      // Fallback: any summary matching ticketNumber
      if (!existingDocId) {
        const anySummary = data.ticketSummaries.find(
          (ts: { ticketNumber?: string; docId?: string }) =>
            String(ts?.ticketNumber) === ticketNumberStr && ts?.docId,
        );
        if (anySummary?.docId) existingDocId = anySummary.docId;
      }
    }
    const packetIdForLink: string | null = (data.packetId as string | null)
      || (data.canonicalJobId as string | null)
      || null;
    if (existingDocId && packetIdForLink) {
      try {
        const now = admin.firestore.Timestamp.now();
        await db.collection('canonical_jobs').doc(packetIdForLink).update({
          ticketDocId: existingDocId,
          ticketNumber: ticketNumberStr,
          updatedAt: now,
          events: admin.firestore.FieldValue.arrayUnion({
            type: 'transferred_ticket_dedup_linked',
            at: now,
            actorSource: 'cf',
            actorDriverHash: (data.driverHash as string | null) || null,
            ticketDocId: existingDocId,
            ticketNumber: ticketNumberStr,
            reason: 'existing submitTicket-created doc found; dedup gate prevented duplicate materialization',
          }),
        });
      } catch (cjErr: unknown) {
        console.warn(
          '[materializeTransferredTicket] canonical_jobs dedup patch failed (non-fatal):',
          cjErr instanceof Error ? cjErr.message : String(cjErr),
        );
      }
    }
    console.log(
      `[materializeTransferredTicket] dedup gate hit for invoice=${invoiceId} ` +
      `ticketNumber=${ticketNumberStr} — existing ticket=${existingDocId || '(unknown docId)'}`,
    );
    return {
      materialized: false,
      skipReason: 'existing_ticket_in_invoice_tickets_array',
      docId: existingDocId || undefined,
      ticketNumber: ticketNumberStr,
    };
  }

  // ── Dedup gate 2: existing materialized doc ────────────────────────────
  // Original idempotency check. Catches replay of the SAME materializer
  // (e.g. trigger re-fires during the follow-up invoice.update arrayUnion).
  const existing = await db.collection('tickets').doc(materializedDocId).get();
  if (existing.exists) {
    return { materialized: false, skipReason: 'already_materialized', docId: materializedDocId, ticketNumber: ticketNumberStr };
  }

  // Build and write the ticket doc
  const ticketDoc = await buildMaterializedTicket(invoiceId, data, pendingTicketNumber);
  await db.collection('tickets').doc(materializedDocId).set(ticketDoc);

  const packetId: string | null = (data.packetId as string | null)
    || (data.canonicalJobId as string | null)
    || null;

  // Back-patch canonical_jobs.ticketDocId + ticketNumber (idempotent — uses update,
  // overwrites if previously null, no-op if same).
  if (packetId) {
    try {
      const now = admin.firestore.Timestamp.now();
      await db.collection('canonical_jobs').doc(packetId).update({
        ticketDocId: materializedDocId,
        ticketNumber: ticketNumberStr,
        updatedAt: now,
        events: admin.firestore.FieldValue.arrayUnion({
          type: 'transferred_ticket_materialized',
          at: now,
          actorSource: 'cf',
          actorDriverHash: (data.driverHash as string | null) || null,
          ticketDocId: materializedDocId,
          ticketNumber: ticketNumberStr,
        }),
      });
    } catch (cjErr: unknown) {
      console.warn(
        '[materializeTransferredTicket] canonical_jobs patch failed (non-fatal):',
        cjErr instanceof Error ? cjErr.message : String(cjErr),
      );
    }
  }

  // Update invoice with tickets[] + ticketSummaries[] so billing/payroll can anchor.
  // arrayUnion dedups by deep equality — safe to retry.
  // 2026-05-15 — qty/location MUST match the ticket doc we just wrote (otherwise
  // dashboard ticket.bbls and invoice.ticketSummaries.qty disagree). Read from
  // the built doc instead of re-deriving from stale invoice.totalBBL / short-form
  // wellName.
  try {
    await db.collection('invoices').doc(invoiceId).update({
      tickets: admin.firestore.FieldValue.arrayUnion(ticketNumberStr),
      ticketSummaries: admin.firestore.FieldValue.arrayUnion({
        ticketNumber: ticketNumberStr,
        docId: materializedDocId,
        complete: true,
        location: (ticketDoc.location as string) || data.wellName || '',
        qty: (ticketDoc.qty as string) || String(data.totalBBL || 0),
      }),
    });
  } catch (invErr: unknown) {
    console.warn(
      '[materializeTransferredTicket] invoice patch failed (non-fatal):',
      invErr instanceof Error ? invErr.message : String(invErr),
    );
  }

  console.log(
    `[materializeTransferredTicket] materialized tickets/${materializedDocId} ` +
    `for invoice=${invoiceId} ticketNumber=${ticketNumberStr} packetId=${packetId}`,
  );

  return { materialized: true, docId: materializedDocId, ticketNumber: ticketNumberStr, packetId };
}

/**
 * Firestore onUpdate trigger. Fires on every invoices/{id} write, gates on
 * status-transition to 'closed' for receiver-side transferred invoices only.
 *
 * Loop prevention:
 *   The materialization routine itself calls invoices/{id}.update() to populate
 *   tickets[] + ticketSummaries[]. That re-fires this trigger. The
 *   `before.status === 'closed'` check at the top of the gate stops the second
 *   pass (since by then before.status is already 'closed').
 */
export const materializeTransferredTicket = functionsV1.firestore
  .document('invoices/{invoiceId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    if (!before || !after) return;

    // Status-transition gate — only fire on the close moment, not subsequent updates.
    if (before.status === 'closed') return;
    if (after.status !== 'closed') return;

    // Must be a receiver-side transferred job
    if (!after.transferSourceDocId) return;

    // Must have a reserved ticket number
    if (!after.pendingTicketNumber) return;

    try {
      const result = await materializeTransferredTicketForInvoice(
        context.params.invoiceId as string,
        after,
      );
      if (!result.materialized) {
        console.log(
          `[materializeTransferredTicket] skipped invoice=${context.params.invoiceId} ` +
          `reason=${result.skipReason}`,
        );
      }
    } catch (err: unknown) {
      console.error(
        '[materializeTransferredTicket] trigger failed:',
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : '',
      );
    }
  });

/**
 * Callable backfill — invokes materializeTransferredTicketForInvoice for already-closed
 * transferred invoices that pre-date the onUpdate trigger deployment. Returns a summary
 * of materializations performed. Idempotent — safe to call multiple times.
 *
 * Input (optional):
 *   { invoiceIds?: string[] }  — restrict to specific invoice ids
 *   { dryRun?: boolean }       — return what WOULD be materialized without writing
 *
 * Output:
 *   { processed: number, materialized: string[], skipped: Array<{id, reason}>, errors: Array<{id, error}> }
 */
export const backfillTransferredTickets = functionsV1.https.onCall(async (data, _context) => {
  const db = fs();
  const inputIds: string[] | null = Array.isArray(data?.invoiceIds) ? data.invoiceIds : null;
  const dryRun: boolean = !!data?.dryRun;

  const results: {
    processed: number;
    materialized: string[];
    skipped: Array<{ id: string; reason: string }>;
    errors: Array<{ id: string; error: string }>;
  } = { processed: 0, materialized: [], skipped: [], errors: [] };

  let invoiceDocs: admin.firestore.QueryDocumentSnapshot[];
  if (inputIds && inputIds.length > 0) {
    invoiceDocs = [];
    for (const id of inputIds) {
      const snap = await db.collection('invoices').doc(id).get();
      if (snap.exists) invoiceDocs.push(snap as unknown as admin.firestore.QueryDocumentSnapshot);
    }
  } else {
    // Find all closed receiver-side transferred invoices.
    // Two clauses, two indexes likely needed. Use two queries and merge.
    const q1 = await db.collection('invoices')
      .where('status', '==', 'closed')
      .where('transferSourceDocId', '!=', null)
      .limit(500)
      .get();
    invoiceDocs = q1.docs;
  }

  for (const doc of invoiceDocs) {
    results.processed++;
    try {
      const data = doc.data();
      if (data.status !== 'closed' || !data.transferSourceDocId || !data.pendingTicketNumber) {
        results.skipped.push({ id: doc.id, reason: 'gates_failed' });
        continue;
      }
      if (dryRun) {
        // Check if already materialized
        const existing = await db.collection('tickets').doc(`transfer_${doc.id}`).get();
        if (existing.exists) {
          results.skipped.push({ id: doc.id, reason: 'already_materialized (dry run)' });
        } else {
          results.materialized.push(`transfer_${doc.id} (would materialize, dry run)`);
        }
        continue;
      }
      const result = await materializeTransferredTicketForInvoice(doc.id, data);
      if (result.materialized) {
        results.materialized.push(result.docId || doc.id);
      } else {
        results.skipped.push({ id: doc.id, reason: result.skipReason || 'unknown' });
      }
    } catch (err: unknown) {
      results.errors.push({
        id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
});
