# DDJD ↔ Dashboard contract fix (identity + Active Jobs) — 2026-09-15

Source-only, frontend. Base `release/dashboard-assigned-visibility-20260914 @ 7706146c`
(deployed base with the assigned-visibility infra + the two diagnosed defects). **No
Functions/rules/Storage/WB-T edits. Not deployed. No production/test records mutated.**

## Defects fixed (reader side)
1. **Attribution by `j.driverHash === d.key`.** Active Jobs grouped by the raw dispatch
   `driverHash` and resolved the driver via `drivers.find(d => d.key === driverHash)`,
   falling back to the stamped login/`'Unknown'` when the hash didn't equal the driver's
   record key (canonical-UUID vs legacy-hash duality → Mikezfold's jobs mis-attributed).
2. **Login/hash shown as identity + queued jobs not consolidated.** The header used the
   stamped `driverName` (login) as a fallback.

## The fix — one shared resolver
New `src/lib/dispatchDriverIdentity.ts` (pure, node-tested): joins dispatches to drivers on
`companyId + canonical driverId` (preferred), with a **governed legacy-hash fallback**
(driver's key / driverHash / bound `legacyAliases`) — **never cross-company, never by name**.
- `dispatchMatchesDriver`, `resolveDispatchDriver` (canonical wins; legacy only if no canonical),
  `dispatchDriverGroupKey` (canonical group key, never a login/hash), `dispatchDriverDisplayName`
  (real `displayName`/`legalName`; unresolved → `'Unassigned driver'`, never the login),
  `dispatchActiveJobState` (pending→queued, pending_approval→review, accepted/in_progress/paused;
  terminal→null), `dispatchVisibleOnDashboard` (phone-only exception gate).

Wired into `src/app/dispatch/page.tsx`:
- **Active Jobs** now groups by `dispatchDriverGroupKey` (canonical) and resolves the header via
  `resolveDispatchDriver` + `dispatchDriverDisplayName` (real name). The pane already renders all
  non-terminal statuses (nonDeclined incl. pending) — so queued/assigned/review DDJD jobs are
  represented; started (accepted/in_progress/paused) behavior preserved; Well Queue muting/removal
  unchanged.
- **Well Queue** assignment attribution (`pwAssignmentByWell`) now shows the resolver's real
  driver name (never the stamped login).
- `ApprovedDriver` + the drivers-list builder now carry canonical `driverId` (and `legacyAliases`
  from `migratedToDriverId`; for UUID-keyed records `driverId` defaults to the key).

## Regression proof
`node --test` — `dispatchDriverIdentity.test.ts` (12) covers all 10 required proofs:
(1) LG pending DDJD w/ canonical driverId included + attaches; (2) pending non-terminal;
(3) started keeps its card; (4) canonical attaches despite obsolete driverHash;
(5) legacy-hash-only resolves via alias; (6) NO cross-company alias match; (7) Review state;
(8) dismissed/completed/cancelled/declined leave; (9) real name never login; (10) non-dispatch
company stays phone-only; + canonical-preferred + canonical group key. `dashboardDdjdWiring.test.ts`
(6) asserts the page wiring. Full suite: **all pass**. `tsc` **0**. `next build` OK (27 routes).

## Suggested drop-off (Gabriel 2) — recorded, NOT implemented here
Root cause confirmed: **recommendation never requested** — the WB-T Job Builder has no
recommend/suggest-disposal call (only `getCompanySwdDirectory` manual picker); no disposal engine
exists. Recorded as an acceptance fixture: `src/lib/__tests__/fixtures/gabriel2-blank-dropoff.json`
(required result: driver's usual eligible drop-off / another verified eligible / explicit
unavailable — never the closest SWD). This is a Route Me / disposal-engine lane item (checkpoint
`f16feae9`, parked, undeployed) and is **not** combined with this DDJD correction.

## Remaining writer paths that still stamp login/hash identity (report only — NOT edited)
Client dispatch writes in `src/app/dispatch/page.tsx` stamp `driverHash: driver.key` +
`driverName: driver.displayName` (real name) but **do not stamp a separate canonical `driverId`**:
- assign (`~1115`), split-leg creates (`~1202/1223/1237/1262`), project adds (`~1413/1532/1622`),
  reassign (`~1750/1769`), transfer assign (`assignTransfer ~1836`).
Two-part correction (outside this reader fix / this lane):
1. **Client:** add `driverId: driver.driverId` to those payloads.
2. **Server (Functions / AntiGravity lane):** the governed `staffWriteDispatch` (and
   driver-self dispatch-create) allowlists must include `driverId`, and server writes must stamp
   canonical `driverId`. Until then, readers remain compatible via this resolver (canonical
   driverId when present; governed legacy-hash fallback). No backfill of disposable test records.

## Files changed
- New: `src/lib/dispatchDriverIdentity.ts`, `src/lib/__tests__/dispatchDriverIdentity.test.ts`,
  `src/lib/__tests__/dashboardDdjdWiring.test.ts`, `src/lib/__tests__/fixtures/gabriel2-blank-dropoff.json`.
- Modified: `src/app/dispatch/page.tsx` (ApprovedDriver type + drivers builder + Active Jobs
  grouping/header + Well Queue attribution + import).
