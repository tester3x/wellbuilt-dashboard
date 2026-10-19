# Watchdog unresolved review mirror — 2026-10-19

Dashboard branch release/dashboard-compact-identity-20261015. HP source remains on codex/watchdog-stockyard-20261016 at 086328e8; no HP source edits.

The HP was connected and watching with remote review sync enabled. syncWatchdogReviewV2 rejected its first blank-well held row as well_not_allowed, stopping the local sequential mirror pass. Cloud held only six old resolved records.

Mirror now accepts bounded unresolved-well snapshots from the authenticated Watchdog principal and approved channels. This is observational only: unresolved/out-of-channel wells are non-editable, actual ingestion allowlists remain unchanged, and review decisions are untouched. Approved named wells retain existing review controls. Seven remote-review tests and Functions build passed.

Current local queue has three review cards covering four named wells (one combined Gunslinger post). No queue row, measurement, load, or review decision changed. Private before-queue and status snapshots retained outside Git.

Source checkpoint; deployment and actual cloud sync verification pending.
