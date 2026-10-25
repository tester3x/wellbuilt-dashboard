# Watchdog unresolved review mirror — 2026-10-19

Dashboard branch release/dashboard-compact-identity-20261015. HP source remains on codex/watchdog-stockyard-20261016 at 086328e8; no HP source edits.

The HP was connected and watching with remote review sync enabled. syncWatchdogReviewV2 rejected its first blank-well held row as well_not_allowed, stopping the local sequential mirror pass. Cloud held only six old resolved records.

Mirror now accepts bounded unresolved-well snapshots from the authenticated Watchdog principal and approved channels. This is observational only: unresolved/out-of-channel wells are non-editable, actual ingestion allowlists remain unchanged, and review decisions are untouched. Approved named wells retain existing review controls. Seven remote-review tests and Functions build passed.

Current local queue has three review cards covering four named wells (one combined Gunslinger post). No queue row, measurement, load, or review decision changed. Private before-queue and status snapshots retained outside Git.

Deployed only syncWatchdogReviewV2 from a5f6d599. Verified ACTIVE revision syncwatchdogreviewv2-00002-goz, update 2026-10-19T23:44:44Z; unsigned requests rejected (400). The normal HP timer synced all three current local review row IDs to exactly three cloud review records, with no extra pending cloud rows and no pending decision commands. HP remains Connected/unpaused; remoteReviewError is empty. Dashboard Refresh can now retrieve the mirrored cards. No frontend release, rules or indexes deployed.
