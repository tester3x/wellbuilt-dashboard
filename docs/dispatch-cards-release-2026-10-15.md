# Dispatch card release

Hosting source: bc765cbe, release/dashboard-compact-identity-20261015. Deployed 2026-10-15 to wellbuilt-sync Hosting only. No Functions or rules deployment. Mandatory certified preflight passed. Live /dispatch/ HTML and all 17 linked JS bundles matched the built files byte for byte.

Cards now display created/assigned and latest stage-update dates, plus live Multi-Haul membership from their own linked, tenant-matched open invoice. Rollback to single removes that badge. Generic in_progress is not silently relabeled as To Pickup.

Broader lib suite: 407 pass, four failures and one cancelled test in the direct Node run. Three failures are extensionless TypeScript module resolution; controlContracts reports the already-existing demoWellPullPlan absent from the older committed callable inventory. These did not fail the mandatory Hosting preflight and are not introduced by this UI diff.

User authorized deletion of the two stale Gabriel dispatch documents. Scoped deletion verified; invoices, tickets, and WB M pull records preserved. WB Tickets stage retry source is checkpoint 134ce11, not built/installed. Published-job cancellation and historical terminal completion recovery remain unfinished and must not be described as fixed by this release.
