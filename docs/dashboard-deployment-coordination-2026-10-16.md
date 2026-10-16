# Dashboard deployment coordination — 2026-10-16

User reports desktop demo work deployed an older Dashboard and is restoring the graphical changes. Laptop will make no further Hosting deployments while that reconciliation is underway. This note is a handoff, not evidence of desktop source or current live state.

Preserved laptop branch: release/dashboard-compact-identity-20261015
Last verified runtime source: d02416c8508f2d107191fb3c7fbcceb48730828c
Release documentation checkpoint: 052dac49
Repository: tester3x/wellbuilt-dashboard

Before the next combined deployment, fetch and compare this branch with the desktop demo branch. Preserve both histories and integrate the intended demo changes with the existing approved Dashboard layout/search/dispatch repairs and driver arrival recommendations; do not release an older full checkout over either lane. Verify the combined source, run the certified Hosting preflight, and byte-verify the resulting live artifacts. Only one lane should deploy the shared Hosting site during reconciliation.

Driver arrival source is committed and pushed, including history-first estimation, on-demand Google fallback, no geographic cutoff or shift gate, and all drivers selectable. The dedicated Google Routes key is supplied via ignored NEXT_PUBLIC_DRIVER_ROUTES_API_KEY, not Git. A desktop build without that environment variable will have no Google fallback. Provision the existing restricted key privately; do not copy it into source or reports. API restrictions allow only the two wellbuilt-sync Hosting origins and Routes API. Do not re-enable paid automatic polling when integrating.

Full verification and limitations: docs/driver-arrival-first-version-wip-2026-10-15.md. No desktop report folder is accessible at C:/dev/reports or D:/dev/reports in this laptop session. This Git-backed handoff is available to desktop after fetch. No direct message was sent to another chat.

## Source-only selector integration and orphan cleanup — 2026-10-16
User clarified recommendations belong inside Select driver, not a separate test panel. Single-job PW selector now opens the ranked explanatory list itself; selecting any row (including Arrival unknown) sets the existing selected-driver state and closes the list. Selected label remains visible and can be cleared. Service Work uses the same chooser with multiple selections retained. Bulk PW and locations not yet chosen retain their original chooser; no fabricated target ranking. All drivers remain selectable while arrival evidence loads. Cost behavior remains explicit open/Refresh only.

The data-demo-builder-target=driver marker remains, but its single-job descendant changes from native select to an expandable button/list. Desktop demo autoplay using selectOption must be reconciled to the new interaction before integration. This checkpoint is NOT deployed and is not permission to overwrite desktop's current demo/layout repair.

User reports no drivers are working tonight. Unknown fresh location is expected; login persistence is not treated as working status. No GPS was invented and no account was removed from selection.

Operational cleanup (separate guarded transaction with private backup): five exact ticket/completed-dispatch-linked stale open invoices closed; two empty abandoned invoice records removed; fresh query confirmed zero open invoices for the affected driver. No tickets, dispatches, WB M pulls/wells modified. Historical exact network failure remains unproven; invoice/dispatch terminal updates are independent. App source checkpoint d1604b0 on codex/wbt-enroute-20261014 repairs the identified missing-close-intent recovery gap using validated saved closed payloads, with no APK built/installed.

Validation: Dashboard TypeScript and all 15 focused estimator/provider tests pass. Production component hook tests cover no paid feed polling, selecting unknown rows, single chooser closes and retains selection. Browser layout of actual chooser markup passes 320/344/768/1280px. Deployment remains on hold; no Hosting, Functions or rule deployment.
