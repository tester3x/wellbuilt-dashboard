# Dashboard-Wide Well-Level Audit — 2026-09-14

Branch: `fix/dashboard-wbm-well-status-live-levels-20260914` (from deployed HEAD
`release/dashboard-assigned-visibility-20260914 @ 7706146c`). **Frontend-only. No
Functions / rules / RTDB / Firestore / Storage changes. Not deployed — awaiting Mike.**

## 1. Exact root causes (traced, not inferred)

### 1a. Aggregate `/mobile` showed a stale last-pull level while the `/well` card advanced
- `/mobile` read `subscribeToWellStatusesUnified` (wells.ts). That builder computes an
  estimate **only** when `config.avgFlowRateMinutes > 0` (wells.ts:338,342). Wells whose
  config carries the flow **string** (`avgFlowRate`) but not the numeric
  `avgFlowRateMinutes` fell through to the **stored** `outgoing.currentLevel` — a value
  the Cloud Function computed once at pull time and never advanced. So those rows were
  frozen at the last-pull reading.
- `/well` re-derived its own estimate on a 30 s `currentTime` ticker (well/page.tsx),
  parsing the flow **string** — so it advanced for the same well. Hence "card moves,
  aggregate doesn't."

### 1b. The `/well` card's local formula was itself a compounding hazard
- Its baseline was `wellStatus.currentLevel` (well/page.tsx:185) — the **stored reading
  already advanced past the pull** — paired with the pull timestamp. That double-counts
  recovery. It only looked right shortly after a pull. **Not copied; refactored away.**

### 1c. Gabriel-2 queue `10'2"` vs Reassign modal stale `4'4"`
- The queue level comes from `classifyWell` (the shared WB-M estimator). The Assign modal
  rendered `assignTarget.currentLevel` and the Reassign modal `reassignJob.currentLevel`
  — the stale stored reading / a value copied onto the job at open time. Different source
  ⇒ different number on screen for the same well at the same instant.

### 1d. Source authorization
- Both `/mobile` (`subscribeToWellStatusesUnified`) and `/well` (`onValue(packets/outgoing)`)
  used the **direct-client RTDB path**, which is permission-denied for dashboard
  (email/password) users — the path Dispatch already abandoned. Migrated to the governed
  `adminGetWellPool` + `mergeWellPool` contract.

## 2. The single shared source of truth

- **`src/lib/wbmLevelEstimator.ts`** (unchanged) — canonical WB-M vc58 estimator.
- **`src/lib/wellLevelProjection.ts`** (new) —
  - `wbmInputsFromWell(well)` resolves estimator inputs from a governed `WellResponse`.
    Baseline is **only** the immutable raw `lastPullBottomLevel` + raw pull timestamp
    (`lastPullDateTimeUTC`, else `timestampUTC`; invalid / pre-2020 rejected). It **never**
    falls back to `currentLevel` — that is the compounding guard.
  - `projectWellLevel(well, asOfMs)` → `{ estFeet, estDisplay, hasFlow, frozen, capped,
    wellDown, available }`. Unavailable ⇒ `'--'`, **never 0**.
- **`src/lib/useSharedNow.ts`** (new) — ONE bounded ticker per page (30 s), immediate
  recompute on `visibilitychange→visible` / `focus` (foreground/resume), deterministic
  teardown. No per-row timers.
- **`src/lib/useGovernedWellPool.ts`** (new) — the SAME authorized source Dispatch uses
  (`adminGetWellPool` → `mergeWellPool`), with the tenant-entitlement gate, bounded retry,
  60 s liveness refresh, and honest `statusUnavailable` (a read failure, never silent
  empty). Never falls back to the forbidden RTDB path or catalog-only data.

`classifyWell` (Dispatch) and `projectWellLevel` (pages/modals) both call
`wbmInputsFromWell` → `estimateCurrentFeet` → `formatFeetWBM`, so one governed response
yields **byte-identical** `estDisplay` on every surface at one `asOfMs` (proven in tests).

## 3. Consumer inventory & classification

| Component | Field / source | Category | Action |
|---|---|---|---|
| `/mobile` table Level column | was `well.currentLevel` | 1 Current | → `projectWellLevel`; header relabeled **Current Level (Est.)** |
| `/mobile` card view | (had no level) | 1 Current | added **Current Level (Est.)** via projection |
| `/mobile` level sort | was `parseLevelToInches(currentLevel)` | 1 Current | sorts by projected inches |
| `/mobile` pullBbls planning (`recalcWellForPullBbls`) | was `parseLevelToInches(currentLevel)` | 1 Current | anchors on live projected inches |
| `/well` "Current Level (Est.)" | was local formula on `currentLevel` | 1 Current | → `projectWellLevel`; local formula removed |
| `/well` "Last Pull" datetime + new "Last Pull Level" | `lastPullDateTimeUTC`, `lastPullBottomLevel` | 2 Last-pull | preserved, labeled |
| Dispatch queue Level cell | `classifyWell(well, asOfMs)` | 1 Current | already shared; clock → `useSharedNow` |
| Dispatch **Assign** modal | was `assignTarget.currentLevel` "Level" | 1 Current | → live pool well + `projectWellLevel` "Current Level (Est.)"; raw shown as "Last Pull" |
| Dispatch **Reassign** modal | was `reassignJob.currentLevel` "Level" | 1 Current | → live pool well + `projectWellLevel` "Current Level (Est.)"; raw shown as "Last Pull" |
| Dispatch detached/pop-out panes | same render + shared `asOfMs` | 1 Current | advances off the one shared clock (no frozen copy) |
| `/mobile` + Dispatch search/filter | per-row projection | 1 Current | unaffected by filtering |
| `/mobile` "Tank @ Level", `/admin` bottom | `tankAtLevel`, config `bottomLevel` | 3 Config | unchanged (configured target/threshold) |
| `/admin` well config edit | `editWellBottom` etc. | 4 Edit form | unchanged (editable values preserved) |
| `AddPullModal` estimated level | raw `lastPullBottomLevel` + `lastPullDateTimeUTC` + flow, projected to the **user-selected** pull time | 4 Edit form | verified correct (raw baseline, no compounding). Left as-is — it projects to a chosen time, not "now". Consolidation candidate. |
| `/mobile`, `/well`, `/`, Dispatch DOWN checks | `currentLevel === 'DOWN'` / `isDown` | 5 Sentinel | unchanged |
| Unavailable everywhere | `'--'` | 5 Unavailable | never 0/fabricated |

DOWN / offline / shut-in freeze at the raw baseline on every surface (estimator handles
it); the status column/badge flags the down state separately.

## 4. Completed-job suppression correction

`isStaleCompletedReentry` (dispatchAssignmentGroups.ts) no longer releases on a 6 h window.
It now releases **only** when a level newer than the completed assignment has actually
landed (`basisMs >= completedAssignedMs`). A missing fresh level stays held (stale /
unavailable) — elapsed time alone never re-creates a duplicate pull opportunity.

## 5. Gates

- `node --test` full suite: **118 pass / 0 fail** (incl. new `wellLevelProjection.test.ts`
  — 12 acceptance tests using a real `mergeWellPool` fixture: cross-surface parity, the
  Gabriel-2 scenario, time-advance-without-packet + no-compounding, deterministic
  predictedReadyAt, new-pull reset, corrected edit, flow change, DOWN aliases,
  missing/invalid/pre-2020 → `'--'`, never-uses-stale-currentLevel, 20' cap).
- `tsc --noEmit`: **0 errors**.
- `next build --webpack`: **success**, all 27 routes generated.

## 6. Files changed
- New: `wellLevelProjection.ts`, `useSharedNow.ts`, `useGovernedWellPool.ts`,
  `__tests__/wellLevelProjection.test.ts`.
- Modified: `app/mobile/page.tsx`, `app/well/page.tsx`, `app/dispatch/page.tsx`,
  `lib/dispatchPriority.ts`, `lib/dispatchAssignmentGroups.ts`,
  `__tests__/dispatchAssignmentGroups.test.ts`, `__tests__/controlContracts.test.ts`.

---

# Release-Gate Addendum — 2026-09-14

Frontend follow-ups committed atop `cd2e98b1`. **No backend/rules/Storage edits.**

## 7. Complete consumer matrix

| # | Consumer (file · component) | Semantics | Raw inputs | Projection fn | Unavailable | Ticks? | Affects ready-order? |
|---|---|---|---|---|---|---|---|
| 1 | `app/mobile/page.tsx` · `WellRow` (table Level) | Current | lastPullBottomLevel, lastPullDateTimeUTC, flowRate | `projectWellLevel` | `'--'` | yes (NowContext) | no (sort is separate) |
| 2 | `app/mobile/page.tsx` · `WellCard` (Current Level (Est.)) | Current | same | `projectWellLevel` | `'--'` | yes | no |
| 3 | `app/mobile/page.tsx` · `sortWells` case `'level'` | Current | same | `projectWellLevel` (inches) | sorts low (−1) | recomputes on tick | orders the LIST only |
| 4 | `app/mobile/page.tsx` · `recalcWellForPullBbls` (pullBbls planner) | Current | live projected inches + config | `projectWellLevel` → inches | falls back to parse, else planner skips | yes | no |
| 5 | `app/well/page.tsx` · Current Status "Current Level (Est.)" | Current | same | `projectWellLevel` | `'--'` | yes | no |
| 6 | `app/well/page.tsx` · "Last Pull" + "Last Pull Level" | Historical | lastPullDateTimeUTC, lastPullBottomLevel | none (raw) | `'--'` | no | no |
| 7 | `app/well/page.tsx` · pull-history table | Historical | packets/processed rows | none | blank | no | no |
| 8 | `app/dispatch/page.tsx` · Well Queue Level cell | Current | same | `classifyWell` (shared resolver) | `'--'` / NEEDS DATA | yes (useSharedNow) | **yes** (predictedReadyAtMs) |
| 9 | `app/dispatch/page.tsx` · **Assign** modal | Current | live pool well by name | `projectWellLevel` | `'--'` (well absent → unavailable) | yes | no |
| 10 | `app/dispatch/page.tsx` · **Reassign** modal | Current | live pool well by name | `projectWellLevel` | `'--'` (job well absent → unavailable) | yes | no |
| 11 | `app/dispatch/page.tsx` · Active Jobs cards | — | job record (driver/status/well) | none (no level rendered) | n/a | n/a | no |
| 12 | `app/dispatch/page.tsx` · job payload writes (assign/reassign/edit) | Historical snapshot | copies `currentLevel` into the dispatch doc at write time | none | n/a | no | no |
| 13 | `app/dispatch/page.tsx` · search/filter (Well Queue) | Current | per-row `classifyWell` | `classifyWell` | as row | yes | yes (within results) |
| 14 | `app/mobile/page.tsx` · search/filter | Current | per-row `projectWellLevel` | `projectWellLevel` | as row | yes | no |
| 15 | `app/dispatch/page.tsx` · detachable/pop-out panes (Queue, Active Jobs) | Current | same render path | `classifyWell` | as row | yes (shared clock) | yes |
| 16 | `app/admin/page.tsx` · well config (bottom/tanks/pullBbls/flow) | Configuration | config values | none | config default | no | no |
| 17 | `components/AddPullModal.tsx` · estimated level at chosen time | Edit-form preview | raw lastPullBottomLevel + lastPullDateTimeUTC + flow → user-selected time | local (raw-anchored; not "now") | seeds from stored, else recomputes | on field change | no |
| 18 | `app/page.tsx` (Home) · down count | Sentinel | `currentLevel === 'DOWN'` | none | n/a | no | no |
| 19 | `app/mobile/page.tsx` · `getStatusPriority` / Tank @ Level | Sentinel / Config | `currentLevel` token / `tankAtLevel` | none | `'--'` | no | no |

No exports/reports in these pages render a live "current" level (Performance pages are
historical accuracy; the `sendLevelToChat` "level report" is a backend/chat feature, out
of this frontend lane). No remaining frontend consumer renders a copied/projected
`currentLevel` as live truth — the Assign modal was tightened to `'--'` when the well is
absent from the live pool (matching Reassign).

## 8. Expanded acceptance proof

`src/lib/__tests__/wellLevelProjection.test.ts` (16) + `controlContracts.test.ts` (+6) +
`dispatchAssignmentGroups.test.ts`. Full suite **128 pass / 0 fail**.

| Property required | Test |
|---|---|
| Numeric ⇄ string flow parity | "numeric and string flow-rate inputs produce identical estimates" |
| Raw baseline never compounds | "display advances … never compounds" + "NEVER uses the stale stored currentLevel" |
| Missing bottom/time → unavailable, not zero | "missing baseline → '--'" + "invalid and pre-2020 timestamps → '--'" |
| Missing flow → frozen at last reading, not zero | "missing FLOW → frozen at the last reading (never zero…)" |
| DOWN frozen consistently (all surfaces) | "DOWN / offline / shut-in freeze…" + "DOWN wells frozen identically on queue and pages" |
| Foreground/resume immediate recompute | contract: "one shared bounded clock (useSharedNow): … foreground/resume recompute …" |
| One shared timer/page, none per row | contract: "one shared timer per page, NONE per row (/mobile + /well)" |
| Clock passage doesn't reorder predicted-ready | "clock passage does not reorder absolute predicted-ready results" + "predictedReadyAt deterministic" |
| Completed suppression never expires to a duplicate pull | dispatchAssignmentGroups: "releases ONLY when a level newer than the assignment lands — never on elapsed time" |
| Assign/Reassign show unavailable, not stale, when governed data absent | contract: "Assign + Reassign modals project the LIVE pool well and show '--' when governed data is absent" |
| Gabriel-2 identical across every surface at one asOfMs | "ONE governed response → identical current estimate…" + "reproduces the Gabriel-2 mismatch…" |

## 9. Governed-source authorization audit (read-only)

`adminGetWellPool` (functions/src/security/adminDashboardCatalog.ts:57) →
`requireRegisteredDashboardUser` (any signed-in registered user) → gates the pool on
`projected.canViewWellPool` = `callerCanViewGlobalWellPool` (dashboardCatalogProjection.ts:227):
`isPlatformAdmin || !companyId || companyId === 'liquid-gold'`. When true it returns the
**entire global** `well_config` + `packets/outgoing` (projected, **not** company-filtered:
`projectMap(..., null)` at :367, `projectWellStatus` has no company filter). When false it
returns `canViewWellPool:false` + empty. `DashboardCaller` (adminAuth.ts): `{ companyId?,
roles[], caps[], isPlatformAdmin }`; `isPlatformAdmin = !companyId && role in {admin,it}`.

### Persona matrix (current callable)

| Persona | companyId | isPlatformAdmin | `canViewWellPool` | Result today |
|---|---|---|---|---|
| Platform / owner (unscoped admin/it) | none | true | true | **Full global pool** |
| Liquid Gold admin/dispatcher/viewer | `liquid-gold` | false | true | **Full global pool** (company-gated, not capability-gated) |
| Ordinary non-LG **admin** | e.g. `acme` | false | false | `canViewWellPool:false` + **empty** |
| Ordinary non-LG **dispatcher** | `acme` | false | false | **empty** |
| Scoped viewer / restricted | `acme` | false | false | **empty** |
| Unscoped viewer (quirk) | none | false | true (`!companyId`) | **Full global pool** — unintended; the gate is company-based, not capability-based |

Two current gaps: (a) ordinary tenants get nothing (the deploy blocker); (b) the pool is
gated by company identity, not by a read capability — an unscoped non-admin still passes.

### Proposed minimum company-scoped governed contract (design only — NOT implemented)

Add a company-scoped branch to the governed read (no client RTDB, no rules change):

- **Server identity is authoritative**: company + caps come from `DashboardCaller`
  (`requireRegisteredDashboardUser`), never from client input.
- **Capability gate**: require an explicit read capability (proposed `viewWellPool`, added
  to `DEFAULT_ROLE_CAPABILITIES` for `admin`/`manager`/`dispatch`; overridable per company
  via `companies/{id}.roleCapabilities`). Fixes gap (b) — no capability, no pool.
- **Company scoping**: when `!canViewGlobalWellPool(caller)` but caller has `companyId` +
  `viewWellPool`, return only wells with `recordCompanyId(config) === caller.companyId`, and
  `wellStatus` **left-joined to that scoped `well_config`** by wellName (so status inherits
  the config's companyId — `packets/outgoing` carries no companyId). Prevents cross-company
  reads.
- **Same raw inputs**: reuse `WELL_CONFIG_ALLOWLIST` + `WELL_STATUS_ALLOWLIST` (already carry
  `lastPullBottomLevel`, `lastPullDateTimeUTC`, `flowRate`, `bottomLevel`, `tanks`,
  `bblPerFoot`, …) so `mergeWellPool` + `projectWellLevel` work unchanged on the client.
- Global-pool personas keep exactly today's behavior.

Proposed shape (either an in-place branch in `adminGetWellPool` OR a sibling
`adminGetCompanyWellPool`):
- `functions/src/security/dashboardCatalogProjection.ts` — add `projectCompanyWellPool(caller, wellConfig, outgoing)` (scoped `projectMap(..., companyId)` + status left-join) and a `viewWellPool` helper.
- `functions/src/security/adminDashboardCatalog.ts` — branch/new callable using it.
- `functions/src/security/adminAuth.ts` — add `viewWellPool` to `DEFAULT_ROLE_CAPABILITIES`.
- Client: extend `useGovernedWellPool` to call the scoped path for non-global personas
  (frontend, deferred until the backend exists).

## 10. Backend collision map (AntiGravity transfer branch)

AntiGravity owns a Dashboard Functions branch touching `functions/src/index.ts` and the
security exports. The proposed contract collides at:

- **Hard (export lists)** — only if a NEW callable name is added:
  - `functions/src/security/index.ts:21-25` (the `adminGetDashboardCatalog / adminGetWellPool / adminGetWellHistory` export block).
  - `functions/src/index.ts:4779-4781` (the matching re-export block).
- **Body/logic** (collides only if their branch also edits security reads):
  - `functions/src/security/adminDashboardCatalog.ts` (`adminGetWellPool`).
  - `functions/src/security/dashboardCatalogProjection.ts` (projection).
  - `functions/src/security/adminAuth.ts` (capability table).

An **in-place** modification of `adminGetWellPool` (no new export) avoids the two export-list
collisions and touches only the three security files. A **new sibling callable** is cleaner
but collides with both export lists. Either way, do not implement until AntiGravity's branch
lands to avoid a three-way merge on `functions/src/index.ts` + `security/index.ts`.

## 11. Remaining deployment blockers

1. **Ordinary non-Liquid-Gold tenants have no governed well-pool source** — `adminGetWellPool`
   returns empty for them. Requires the §9 backend contract (backend lane, AntiGravity
   collision). **Frontend is ready**: `useGovernedWellPool` already reports the entitlement
   gap honestly and never falls back to the forbidden RTDB path.
2. Backend Functions lane is frozen (AntiGravity transfer branch on `index.ts` + security
   exports) — no Functions/rules/Storage deploy from this lane.
