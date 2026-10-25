# Dispatch level and shift-status repair — 2026-10-24

Branch: release/dashboard-tank-info-20261024. Reconciled the newer release/dashboard-current-20260927 dispatch picker, dated shift planning and review/history changes with the approved tank-info release; retained the approved release lock, fresh-source and live-byte verification hooks, return-state fixes, governed water-order callable and primary-route controls.

The live staffResolveCompanyDriverShifts source (ACTIVE, updated 2026-09-16) accepts only driverIds. The client sent companyId, causing strict request rejection and gray unavailable dots. The request now matches the deployed contract; tenancy remains authenticated server authority, with canonical per-driver lookup and cross-company client guard. Both PW paths use that same result.

Single and multiple PW dispatch previously persisted raw currentLevel, which can be the last-pull baseline. Both now project the live well pool at the exact captured assignedAt timestamp, saving a historical dispatch snapshot without modifying well readings. Missing inputs remain unknown. All wells in one bulk dispatch use one assignment clock.

Validation before release: TypeScript clean; library tests 476 passed, one skipped; retained arrival panel and Water Orders workflow passed; new actual shared picker test proves 35 open / 7 closed canonical results survive single-to-multiple mode, 42-driver selection/search and four widths. Mandatory preflight includes the new picker and library regression.

Not yet deployed at this checkpoint. Existing dispatch records have not been edited.
