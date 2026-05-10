# Canonical Jobs — Backfill Plan (Phase 1)

**Status: PLAN ONLY. Do not execute without separate approval.**

The accompanying `backfill-canonical-jobs.mjs` script is a dry-run skeleton.
It will refuse to make any writes unless `--commit` is passed AND a separate
operator confirms via stdin.

## Goal

Populate `canonical_jobs` for historical packets / tickets / transfer_requests
that pre-date the Phase 1 write hooks. After this runs, every recent job has
a canonical bridge row, so Phase 2 reader migration has something to read.

## Strategy (least-risky path)

### Pass 1 — Packets (RTDB → Firestore)

Source: RTDB `packets/processed/{packetId}`
Target: `canonical_jobs/{packetId}`

For each packet:

1. Skip if `canonical_jobs/{packetId}` already exists (idempotent).
2. UPSERT with `source: 'wbm'`, event `packet_sent`, fields:
   - packetId, wellName, dateTimeUTC, bblsTaken, tankLevelFeet, tankAfterFeet
   - driverHash (= packet.driverId), driverName (= packet.driverName)
   - companyId — DERIVED from well_config / driver if available (best-effort)

Bound: most recent 30 days, or `--since=<ISO>` flag. Default: 7 days.

### Pass 2 — Tickets (Firestore)

Source: `tickets` ordered by `createdAt desc`
Target: `canonical_jobs/{packetId}` if ticket has packetId, else autoid.

For each ticket:

1. If `ticket.packetId` set:
   - Read `canonical_jobs/{ticket.packetId}` (created by Pass 1).
   - PATCH `ticketDocId`, `ticketNumber`, `invoiceDocId`, `invoiceNumber`,
     `dispatchId`, `companyId`, `truck`, `trailer`, `hauledTo`.
   - Append event `ticket_submitted` with timestamp = ticket.createdAt.
2. Else (no packetId):
   - Create `canonical_jobs/cj_<ts>_<rand>` with ticket fields.
   - source: 'wbt', event `ticket_submitted`.

Bound: most recent 30 days, or `--since=<ISO>` flag.

### Pass 3 — Transfer requests (Firestore)

Source: `transfer_requests` ordered by `createdAt desc`
Target: `canonical_jobs/{request.sourcePacketId}` (DERIVE if missing — see below)

For each request:

1. Resolve packetId:
   - Try `request.sourcePacketId` (if WB T client started writing it).
   - Else load `invoices/{request.sourceInvoiceDocId}` and read `.packetId`.
   - Else look up `tickets where invoiceDocId == request.sourceInvoiceDocId`,
     pull `.packetId` from the first match.
   - If still null → SKIP this request (RULE 5: no canonical row from
     transfer-only events). Log to backfill report.
2. Append event matching `request.status`:
   - `pending` → `transfer_requested`
   - `accepted` → `transfer_requested` then `transfer_accepted`
   - `cancelled` → `transfer_requested` then `transfer_cancelled`
   - `declined` → `transfer_requested` then `transfer_declined`
   - `expired` → `transfer_requested` then `transfer_expired`
3. For accepted: also patch driverHash / driverName / truck / trailer to
   the receiver, preserving originalDriverHash from Pass 1 / Pass 2.

Bound: most recent 30 days.

## Reconciliation case

A ticket-first canonical row (auto-id, no packetId) was created in Pass 2,
then the matching packet shows up in Pass 1's later run. The two rows are
disjoint until reconciliation:

- Match by `ticketNumber` (Firestore composite query).
- Move events array from auto-id row → packetId row.
- Delete auto-id row.

Phase 1 acceptance: leave both rows. Reconciliation is its own follow-on
(Phase 1.1) once we have a clearer picture of how often it actually happens.

## Outputs

Each pass writes to `canonical_jobs_backfill/{batchId}` (a sibling
collection used only by the backfill tooling) with:

- `pass`: 1 | 2 | 3
- `processed`: count
- `created`: count
- `patched`: count
- `skipped`: count + reasons array
- `errors`: array (capped 50)
- `startedAt`, `finishedAt`, `since`

## Order of execution (when approved)

1. `--dry-run --pass=1` → review report
2. `--dry-run --pass=2` → review report
3. `--dry-run --pass=3` → review report
4. `--commit --pass=1`
5. `--commit --pass=2`
6. `--commit --pass=3`
7. `validate-canonical-jobs.mjs` final read-only sweep

## Out of scope for Phase 1

- Reconciliation of auto-id rows with later-arriving packets
- Multi-haul / haulGroupId linkage
- WB JSA / shift backfill
- Equipment ID resolution (truckId / trailerId stay null)
- Project linkage backfill
