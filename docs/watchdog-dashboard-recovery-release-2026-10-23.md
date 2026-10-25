# Watchdog dashboard recovery release — 2026-10-23

Deployed Hosting source: 638715a62734ff6388a4e4678f7ed8593db06cd7.
The guarded release verified all 362 live export files byte-for-byte before
advancing origin/release/dashboard-approved-base. It retained manual-only
Watchdog refresh, route restoration, dispatch cleanup and the approved demo
media/completed-date changes. The mandatory browser checks now also exercise
rejected-load recovery/exclusion, reason gating, server errors/retry and company
scope. The 461 library checks completed with 460 passes and one existing skip.

For a server-rejected older observation, managers can enter a reason and select
Record older load. This calls resolveWatchdogRejectedReview directly; it does not
require a foreground HP session or wait for an HP command. The server verifies
company authorization, revision, actual rejection and source identity, adds the
original observation once to historical records, and preserves the current gauge
and latest load. Exclude report is a separate audited action and preserves the
original rejected report. Unsupported holds retain their existing reconciliation
message rather than offering a misleading send action.

Backend/worker implementation and operational verification are recorded in the
Watchdog lane's docs/watchdog-catchup-recovery-2026-10-23.md. No mobile APK or rules
deployment was involved. A Windows command-line quoting defect in the deployment
wrapper was also corrected; all release hooks and live verification remained in
force.
