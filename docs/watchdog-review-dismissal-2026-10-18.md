# Watchdog review dismissal — October 18, 2026

Source branch: `codex/watchdog-stockyard-20261016`.
Runtime source checkpoint: `086328e8`.

User requested clearing the historical backlog, duplicate matches, orphan routing
instruction badge and estimated-volume review cards. Added a local-only
`/dismiss-review` endpoint behind the existing localhost, host/origin and
per-process-token checks. It retains receipt identity, original issues,
measurements, estimates and pending-correction metadata. A dated dismissal note
records the previous review status. Duplicate disposition is explicit; other
held entries archive without being declared invalid or confirmed. Archived
entries are not ingested or receipt-refreshed back into the review queue.

The browser offers Dismiss review even when the original post is not eligible
for resubmission. No measurement input or replay eligibility is required to
clear a card. Already-resolved normal deliveries cannot be dismissed via this
endpoint. No hard deletion, cloud packet writes, estimate confirmation or
outgoing WhatsApp messages are part of this action.

Four meaningful tests passed on laptop and HP: orphan/rejected dismissal,
duplicate measurement preservation, estimate retention/no resend or receipt
revival, and invalid-request/persistence rollback behavior. JavaScript syntax
checks passed for the server and UI. No APK, Hosting, Functions or rules deploy
was needed for this local feature.

Runtime updated via fast-forward on HP. Saved the original queue before the
restart and a separate private before/after audit for every targeted record.
Through the authenticated local API, cleared exactly 21 snapshotted held
records: four duplicates, one non-load instruction and sixteen archived
reviews. Those sixteen include the incomplete and completed-but-provisional
estimates; volumes remain unverified rather than being promoted to actuals.
Verified local reviewInbox=0 and remaining review flags=0. Existing WB M history
was retained. Receiver freshness after the restart is verified separately.

Refresh the Watchdog browser page to load the new dismissal button. Private
connection details, queue backups and record-level audit data remain outside Git.
