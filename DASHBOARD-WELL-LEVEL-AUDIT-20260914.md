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
