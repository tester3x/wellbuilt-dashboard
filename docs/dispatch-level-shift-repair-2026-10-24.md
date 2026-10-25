# Dispatch level and shift-status repair — 2026-10-24

Branch: release/dashboard-tank-info-20261024. Reconciled the newer release/dashboard-current-20260927 dispatch picker, dated shift planning and review/history changes with the approved tank-info release; retained the approved release lock, fresh-source and live-byte verification hooks, return-state fixes, governed water-order callable and primary-route controls.

The live staffResolveCompanyDriverShifts source (ACTIVE, updated 2026-09-16) accepts only driverIds. The client sent companyId, causing strict request rejection and gray unavailable dots. The request now matches the deployed contract; tenancy remains authenticated server authority, with canonical per-driver lookup and cross-company client guard. Both PW paths use that same result.

Single and multiple PW dispatch previously persisted raw currentLevel, which can be the last-pull baseline. Both now project the live well pool at the exact captured assignedAt timestamp, saving a historical dispatch snapshot without modifying well readings. Missing inputs remain unknown. All wells in one bulk dispatch use one assignment clock.

Validation before release: TypeScript clean; library tests 476 passed, one skipped; retained arrival panel and Water Orders workflow passed; new actual shared picker test proves 35 open / 7 closed canonical results survive single-to-multiple mode, 42-driver selection/search and four widths. Mandatory preflight includes the new picker and library regression.

Not yet deployed at this checkpoint. Existing dispatch records have not been edited.
## Verified release and live repair

Deployed source: e5a8e59ff5607711d91f07f8eed515192ef11910.
Hosting version: 52a3b4c6afe3edbe; release 2026-10-25T00:33:29.262Z.
All mandatory preflight checks passed. Postdeploy independently byte-matched all
371 exported artifacts and advanced the approved checkpoint normally, releasing
the shared lock. Firebase CLI then emitted a process-exit timeout after its
“Deploy complete” message; the release, byte verification and checkpoint advance
were independently confirmed, so no duplicate deployment was attempted.

Authenticated live verification: selected two queue wells and opened Build PW Job
without dispatching. Both active device accounts showed On shift in the shared
picker. Cleared the unsent selection afterward. No real-driver test dispatches
were created.

The two reported existing dispatch levels were reconstructed at their unchanged
original assignment timestamps from the captured pre-assignment pull baseline
and flow inputs: 11′7″ and 11′3″. A transaction changed only currentLevel on those
exact two records, checking identity, prior value and assignment timestamp.
Actual Jobs UI readback confirmed both values. A concurrent legitimate flow update
on the in-progress job was preserved; no tickets, status, well baseline, routing,
load count or assignment times were changed. Private before/after evidence and
screenshots remain outside Git.
