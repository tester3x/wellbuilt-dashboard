# Dashboard UX checkpoint + Route Me / disposal contract — 2026-09-15

Two lanes:
- **Delivered (this branch, frontend-only, tested):** Dashboard parts 5, 6, 7.
- **Contract/audit only (no code — backend does not exist):** Route Me shared routing
  engine + self-scoped callable, DDJD, disposal engine, cross-app exactly-once identity.

**No Functions / rules / Storage / WB-T / AntiGravity-branch edits. Not deployed.**

Base: `fix/dashboard-wbm-well-status-live-levels-20260914 @ 4386ccef` (retained; this is a
new branch atop it). Retained untouched: well-pool security `2daf0006`.

---

## A. Investigation (steps 1 & 4) — proven facts

### A1. Route ranking / assisted routing
- **No server-side routing engine and no routing callable exist.** The only ranking is
  client-side `src/lib/driverEta.ts` (`calculateDriverETAs`/`applyDeadline`) + Google
  Distance Matrix (`src/lib/directions.ts`). It scores **drivers against one target well**
  (ETA / can-make-it), NOT wells-for-one-driver ordering. There is no nearest-well or
  route-sequencing optimizer.
- The Dashboard Well Queue's live level / TTP / priority / assignment come from
  **client-side** `src/lib/dispatchPriority.ts` (`classifyWell`, `predictedReadyAtMs`
  sort), `src/lib/dispatchAssignmentGroups.ts` (assignment/muting), `src/lib/wellLevelProjection.ts`
  (WB-M vc58 level), over the governed pool (`adminGetWellPool` → `mergeWellPool`).
- **No self-mode "rank wells for driver X" scoping exists.** The dashboard feeds ALL
  drivers to the client engine. Secure self-scoping primitives DO exist server-side
  (`requireSecureDriver` derives driverId/companyId from the session, ignores client
  companyId) but are not wired to any ranking.
- **No DDJD concept anywhere** (no callable, no data, no code) in Dashboard or WB-M.

### A2. WB-M data sources (from D:\dev\WB-M)
- Identity: Firebase Auth custom-token session; canonical driverId/companyId server-verified
  (`bootstrapWbmSession`, `verifyDriverSession`), SecureStore mirror. **Not client-authoritative.**
- Assigned wells/routes: governed callable **`bootstrapWbmSession`** (`src/services/wellConfig.ts`),
  eligibility in `src/services/eligibility.ts`; client also re-scopes via `scopedWellsForDisplay`/
  `filterWellConfigByAssignment`. **No global-pool client read.**
- Live status: callable `getDriverOutgoingStatus`. Pull submit: callable `secureIngestPacket`
  (`src/services/secureOperationalApi.ts`, `firebase.ts`). Edit: `secureIngestEdit`.
- **No GPS, no disposals, no routing algorithm** in WB-M. Canonical vc58 estimator lives in
  `app/(tabs)/index.tsx:454-460` (WB-M is the ORIGIN; the Dashboard mirrors it).
- Expo Router (file-based). Bottom nav is hand-rolled in `app/(tabs)/index.tsx`
  (History 📋 | Pull [tan] | Summary 📊). App switcher (floating + grid) in
  `src/components/AppSwitcher.tsx`, mounted in `app/_layout.tsx`.

### A3. Disposal recommendation audit (step 4)
There is **no disposal engine** — disposal is 100% manual human autocomplete over the
**entire unfiltered** `disposals` collection (`src/lib/firestoreWells.ts:176` `loadDisposals`,
`searchDisposals`). Server callables treat `disposal`/`hauledTo` as opaque pass-through strings.

| Rule | Status | Evidence |
|---|---|---|
| 1. Build valid set (company/customer/operator + water type) | **NO** | `loadDisposals()` returns all; no filter args anywhere |
| 2. Exclude blacklisted/unavailable | **NO** | `swd_directory.isBlacklisted` is written in `SWDDirectoryCard.tsx` but has **zero readers** at selection |
| 3. Prefer driver's most-common disposal per canonical well | **NO** | no history/frequency logic; `driverDisposals` is manual entry |
| 4. Never globally-closest before eligibility | **SATISFIED (vacuously)** | no distance logic touches disposal at all |
| 5. Missing eligibility → "No verified drop-off" | **NO** | blank string stored; no such fallback exists |
Well identity for disposal is a raw `wellName` string — no canonical key wired in.

---

## B. Required missing backend contracts (for the AntiGravity packet — do NOT build here)

### B1. Shared self-scoped Route Me routing callable — `getDriverRouteMe` (NEW)
ONE routing core, two entry modes:
- **WB-M / WB-T self mode:** `requireSecureDriver(request, { allowLegacyHash:false })` — server
  derives canonical `driverId`, `companyId`, `assignedRoutes`, `assignedWells` from the
  authenticated session. **Client supplies NO driverId/companyId.** Ignore any client tenant.
- **Dashboard staff mode:** `requireManageDrivers` + an explicit authorized `targetDriverId`
  (company-scoped), evaluated through the same core.

Response (same shape both modes; drives WB-M Route Me + Dashboard queue-per-driver):
```
{
  ok: true,
  capabilities: {
    canViewRouteMe: boolean,        // entitlement (server; never inferred from install)
    canCreateWbmPull: boolean,      // may record a manual WB-M pull
    canCreateDdjd: boolean,         // Phase 2; false in Phase 1 pilot
    ddjdUnavailableReason: string   // e.g. "WB-T not enabled", "no WB-T authority"
  },
  wells: [{
    wellName, companyId, wellId /* canonical */,
    // shared classification (NOT recomputed per app): level(vc58), ttp,
    // priority/state (pull-now|approaching|verify|down|no-gain), predictedReadyAtMs,
    // pullsPerDay, assignmentState (unassigned|assigned_self|assigned_other|in_ddjd),
    // assignee, muted, completedSuppressed
    // disposal recommendation (see B3): recommendedDisposal | "No verified drop-off"
  }],
  asOfMs
}
```
Ordering by `predictedReadyAtMs` (the queue's existing order). Empty assignments → `wells: []`
(fail closed; no global/name fallback). This is the endpoint WB-M Route Me must call; it does
not exist today (see A1). **Until it ships, WB-M Route Me renders fail-closed** (see D).

### B2. DDJD submit callable (Phase 2 — deferred, AntiGravity/DDJD lane)
`submitDdjd({ wells: [{wellName|wellId}], ... })` → creates canonical DDJD jobs for checked
wells (self mode: auth-derived driver; staff mode: authorized target). Requires `canCreateDdjd`.
No such callable exists. **Do not implement in Claude's lane.**

### B3. Disposal recommendation (server) — for `getDriverRouteMe.wells[].recommendedDisposal`
Implement the 5-rule engine server-side: build eligible set (company/customer/operator +
water type) → exclude `swd_directory.isBlacklisted`/unavailable → within eligible, prefer the
authenticated driver's most-common disposal for that canonical well when still best → never
globally-closest before filtering → else `"No verified drop-off"`. Needs a canonical well key
(the `functions/src/truth-layer/` canonical location identity exists but is not wired to dispatch).

### B4. Cross-app exactly-once pull identity (Phase 2)
A manual WB-M Pull must NOT mint a second canonical pull when a WB-T dispatch already
represents the load. Contract: WB-M Pull (`secureIngestPacket`) and WB-T job completion must
share an **idempotency/packet identity** keyed on `(companyId, canonicalWellId, loadId/jobId)`
so both converge on `packets/incoming → packets/processed → packets/outgoing` exactly once;
a duplicate binds to the existing job/packet or fails with an explicit conflict.
- **Exact WB-T hook to locate (AntiGravity):** the WB-T (waterticket-app) job-completion path
  that emits the canonical pull/ticket packet — the point that writes `packets/incoming` (or its
  governed ingest). WB-T was NOT traced here (out of lane: "do not modify WB-T"). AntiGravity
  must identify this hook and add the shared idempotency key on both producers.

---

## C. Delivered this checkpoint (frontend-only, tested)

### Part 5 — Dashboard Well Queue → exact WB-M well by CANONICAL identity
- `src/lib/wellPoolCore.ts`: client `WellResponse` now carries `companyId` + `ndicApiNo`
  (already in the governed `WELL_CONFIG_ALLOWLIST`; threaded through `mergeWellPool`).
- `src/lib/wellDetailLink.ts` (new): `wellDetailHref(well)` = `/well?company=<companyId>&api=<ndicApiNo>`,
  **null when either is missing** (fail closed, no wellName fallback).
- `src/app/dispatch/page.tsx`: queue row navigates to the canonical link (well name shown as a
  link; non-canonical wells show an "Open in WB-M unavailable" affordance, non-navigable). The
  action/control cell `stopPropagation()`s so Assign/Reassign/checkbox/loadcount never navigate.
  Applies in the main queue AND the detached pane (same subtree).
- `src/app/well/page.tsx`: resolves by exact `(companyId, ndicApiNo)` when present; no name
  fuzzy fallback; canonical-not-found renders an explicit "unavailable" notice.

### Part 6 — Detachable-pane cleanup
- Removed the docked placeholder card; the detached pane's wrapper is `display:none` and the
  desktop grid drops the vacated area (`is-queue-detached`/`is-jobs-detached` on `.dispatch-workspace`)
  so the remaining panes reflow to fill it. Reattach lives in the portaled pane header
  (existing toggle, now the sole affordance). The child window is a **named** target
  (`wb_<title>`) and closing it auto-reattaches → no duplicate/stranded pane. Assignment from
  the detached pane still writes to the same canonical state (same React subtree — unchanged).

### Part 7 — Browser-refresh preservation
- Dispatch Well Queue view / route filter / search initialize from the URL and persist to it
  via `history.replaceState` (no navigation), so a reload restores the exact location. Persist
  is gated on resolved auth + present user (no timing hack); the default→/login redirect already
  waits for `!loading`. Builder tab + detach state persist via localStorage (pre-existing), so
  the detached panes re-open on a main-window reload.
- **Known limitation (documented, not a Phase-1 blocker):** the detached pane is an
  `about:blank` popup (no URL); if the USER reloads that popup window itself it goes blank.
  Restoring the popup across its own reload needs a dedicated pane route (larger change) — noted
  for a follow-up.

Gates: `node --test` 139/0 (incl. new `wellDetailLink.test.ts` + `dashboardUx.test.ts`),
`tsc --noEmit` 0, `next build --webpack` OK (27 routes).

---

## D. WB-M Route Me — Phase 1 plan (separate WB-M checkpoint)
- Part 2 bottom nav (History | Pull | ••• More) + More sheet (Route Me, Summary, Switch Apps
  via the existing AppSwitcher grid; remove the floating switcher) — independent frontend.
- Part 3 Route Me page calls `getDriverRouteMe` (B1) via WB-M's existing `authorizedCallable`
  self scope. Because B1 is not deployed, the page is **fail-closed**: honest "Route Me is being
  enabled" state; it never copies routing math and never reads a global pool. DDJD control
  visible but **disabled** ("WB-T assignment not enabled yet"); checkboxes render for UX only and
  cannot submit/persist (Phase 1). No dispatch/DDJD writes.
- Phase 2 (DDJD enable, WB-T Route Me, canonical DDJD jobs, living list, exactly-once) — NOT
  authorized now.
