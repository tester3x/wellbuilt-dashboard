# Watchdog navigation release — 2026-10-18

Remote reviews are deployed and explicitly enabled on the HP. The existing Watchdog navigation entry and page were still hidden by the source default-off release flag. This release makes them available by default, retaining NEXT_PUBLIC_WATCHDOG_REMOTE_REVIEW=disabled as the explicit off switch. Existing viewDispatch navigation permission and authenticated company-scoped review APIs are unchanged.

Validation: library suite459 passed,1 skipped via tsx (plain Node strip-types cannot resolve several existing extensionless imports). Header navigation expectation updated for the released default. Certified Hosting preflight/build/render checks and live byte comparison remain required before deployment. Unrelated app.json in the main working checkout was preserved by using this clean release worktree.

Read-only Watchdog check: HP connected, watching, unpaused; transport Ready; remote syncing enabled with no mirror error. All25 current-day delivery packet IDs confirmed processed in WB M; no pending/rejected/unconfirmed packets and no parsed row missing a delivery state. Two review cards need a decision (one estimated amount, one possible app duplicate). No review or load decisions changed in this release task.

Deployed Hosting source7f9cf115 through the certified preflight. Fresh production build, header navigation, photo-review contract, authenticated responsive routes, job-builder scroll and forgot-password DOM checks all passed. Full live artifact comparison:348/348 files match exactly, zero mismatches. Remote review list/page now available by default; explicit disabled switch retained. No Functions/rules deployment in this release. Review decisions remain unchanged pending the owner's measurement/duplicate clarification.
