# Well search presentation checkpoint

Branch: release/dashboard-compact-identity-20261015. Based on 6a840787.

Search results use the existing governed company well pool, classifyWell and
compareQueueRows. Exact/prefix name relevance remains ahead of queue urgency;
the result cap follows ranking. Exact canonical/NDIC aliases share a reading;
ambiguous aliases and unmaintained locations do not receive invented levels.
Current estimated levels appear at the right, including DOWN where applicable.
Heavy Water retains its explicit weight ordering. Generic operator lists retain
their order. Keyboard selection resets when result identities/order change.

Covered surfaces: Dispatch shared location/catalog rows and builders, completed
job editing, driver destination search, and shared Add Pull well search.
The shared Add Pull change also applies on Mobile Well Status and Well History.

Validation: TypeScript passes; new presentation tests 2/2 pass. Full lib
suite: 412 pass, 4 existing failures (callable inventory and three extensionless
Node import failures), 1 skipped. Certified Hosting preflight passes, including
authenticated route rendering, header navigation, photo review and autocomplete
scroll. Actual search-row components pass Chromium layout checks at 320, 344,
600 and 1024 pixels: no overflow or name/level overlap; DOWN visible and unknown
levels omitted. Reproduce with tools/test-well-search-rows.mjs after a fresh build.

Deployed product source: 7cc25780. Verified 2026-10-16 03:45 UTC (Oct 15 local):
live Dispatch HTML + 18 linked JavaScript assets and Mobile HTML + 19 linked
assets byte-match the fresh out/ artifacts. Existing Job Builder label and
bottom-of-page unrouted-ticket section remain present.

WB Tickets counterpart: fb01b32 on codex/wbt-enroute-20261014. It is not included
in Hosting and requires a later APK; no new APK installed for this request.

User confirmed: needs a load soonest. No operational records changed.

## Flow-aware ordering follow-up

Matched wells now sort by flow-derived next-load readiness ahead of prefix/name
relevance, retaining a directly typed exact match first. The shared estimator
already accounts for flow, allowed bottom and tank capacity; name ranking had
been allowed to override that order. Ready wells retain earliest-ready-first
ordering; down wells now match Summary's highest-frozen-level-first tie breaker.
No inferred readiness for missing flow or geometry. No operational records changed.

New regression: lower fast-filling well precedes higher slow-filling well, and
two tanks reach a load sooner than one tank at the same level/flow. Three focused
tests and TypeScript pass. Follow-up product source 2231baed deployed and verified
2026-10-16 03:53 UTC (Oct 15 local): certified preflight passed; live Dispatch HTML
and 18 linked JS assets, Mobile HTML and 19 linked JS assets byte-match fresh out/.
Actual-row layout check again passes at 320/344/600/1024 pixels. Full lib suite
413 pass, 4 unchanged baseline failures, 1 skipped. WB Tickets counterpart f899ffc
is committed/pushed and Android JS export passes; no APK built or installed.
