# Company-Scoped Governed Well Pool — 2026-09-14

Branch `security/dashboard-wellpool-containment-20260914` (atop containment `19db3c5b`,
base Functions source `fix/photo-lifecycle-safety-20260913 @ 6ee6c3bf`). **Source-only.
Not deployed. No production data touched.** Avoids AntiGravity collision files
(`functions/src/index.ts`, `functions/src/security/index.ts`, `functions/src/security/operational/index.ts`).

## Authorization modes (adminGetWellPool)
1. **Global** — `callerHasGlobalWellPoolAccess`: `isPlatformAdmin === true && caps ∋ viewAllCompanies` → governed GLOBAL pool.
2. **Company-scoped** — `callerCompanyWellPoolScope`: explicit `companyId` + `caps ∋ viewWellPool` → that company's pool only (`projectCompanyWellPool`).
3. **Denied** — everyone else → identical `{canViewWellPool:false, wellConfig:{}, wellStatus:{}, counts:{0,0}}`.

`viewWellPool` is **never** a global grant. Company name, a bare missing `companyId`, and
Liquid Gold membership never grant global. A tenant self-granting `viewAllCompanies` via
company `roleCapabilities` still gets **only its own** pool (mode 1 requires `isPlatformAdmin`,
which requires no `companyId`).

## Default `viewWellPool` role mapping (functions/src/security/adminAuth.ts)
Granted by default to the dashboard roles already intended to view Well Status / Dispatch:

| Role | viewWellPool default | Notes |
|---|---|---|
| `it` | yes | also `viewAllCompanies` → global when unscoped |
| `admin` | yes | company-scoped (global only if unscoped + viewAllCompanies) |
| `manager` | yes | |
| `dispatch` | yes | |
| `viewer` | yes | read-only company scope |
| `payroll` | no | does not view the well pool |
| `driver` | no | uses WB-M app, not the dashboard pool |

A company may **grant or revoke** company-scoped viewing via `companies/{id}.roleCapabilities`
(e.g. `{ viewer: [] }` revokes it); it can never confer global authority.

## Company-safe projection (projectCompanyWellPool)
Filters BEFORE projection; no global `wellName` join; no `companyId || 'liquid-gold'` default.
A configured well is included only when `config.companyId === caller.companyId` (exact). A
status row is attached ONLY when, on the RAW outgoing row: `status.companyId === caller.companyId`
**and** `canonicalWellId(status) === canonicalWellId(config)` (wellId, else id). Any missing
identity fails closed → the well is returned with **no status** (client shows unavailable),
never a foreign row, never zero. Reading raw rows (not the wellName-deduped global projection)
lets an owner recover its own status even when another company's row shares the well name; if
the global writer's dedupe left only the foreign row, the owner gets config + unavailable.

## Proof (functions/src/security/__tests__/wellPoolAccess.emulator.e2e.test.ts)
Real callable `adminGetWellPool.run(...)` against emulated RTDB+Firestore — **21/21**:
platform-with-cap → global; platform-without-cap / no-companyId / custom-role / revoked /
denied-personas-identical; company admin/dispatch/viewer → company-a only; cross-company
input ignored; tenant self-escalation → own pool only; same-name two-tenant (each gets only
its own); writer-loss (owner gets unavailable, not the foreign row); platform writer-loss
limitation documented; plus pure projection/gate truth-tables. Broader functions suite: 840
pass, 1 pre-existing unrelated failure (`invoiceCloseClosedAt`, fails on pristine base too).
tsc 0.

TRANSPORT NOTE: `.run()` exercises the real handler + auth resolution + DB I/O but NOT the
onCall HTTPS transport / App Check / token-decode boundary (Firebase-owned, unchanged here).

## Writer migration plan (DEFERRED — producer NOT edited; touches the collision file index.ts)
`packets/outgoing` is currently keyed by a wellName-derived responseId and **deduped by
wellName** (index.ts:1312), so a same-named pull from another company overwrites the owner's
row. Producer already stamps `companyId = config.companyId || 'liquid-gold'` (index.ts:1211)
but not `wellId`, and the projection strips `companyId`. Smallest safe migration, in order:

1. **Stamp `wellId`** (canonical `config.wellId ?? config.id`) onto the outgoing row alongside the existing `companyId` (index.ts outgoingResponse ~1194-1211, and the edit/delete writers).
2. **Scope the dedupe** to the composite identity — remove/replace only rows with the same `(companyId, wellId)` (or same canonical `wellId`), not the same `wellName`.
3. **Key by a company-safe key** — e.g. `packets/outgoing/<companyId>__<wellId>` (or retain responseId but index by companyId+wellId) so it is one-row-per-(company, well), deterministic.
4. **Carry identity through projection** — add `companyId` + `wellId` to `WELL_STATUS_ALLOWLIST` (needed once a composite-keyed global projection exists; the scoped read already checks raw rows).
5. **Drop the `|| 'liquid-gold'` default** in `outgoingCompanyId` once `well_config.companyId` is authoritative for all wells, so a missing config companyId fails closed rather than mis-stamping as liquid-gold.
6. **Backfill (separate, gated, NOT now)** — stamp legacy outgoing rows from `well_config` companyId/wellId ONLY where config companyId is explicit; leave the rest unattributed (fail closed). No production mutation in this task.

**Collision/sequencing:** steps 1–3, 5 edit `functions/src/index.ts` (AntiGravity collision
file) → must be sequenced AFTER AntiGravity's branch lands. This scoped-READ branch is
independent of that producer work.

## Deploy (eventual, when approved)
Single-function target: `firebase deploy --only functions:adminGetWellPool`. The
`adminAuth`/`dashboardCatalogProjection` changes are bundled into that function's build and the
new `viewWellPool` capability is consumed ONLY by `adminGetWellPool`, so no other function
needs redeployment. **Not deployed in this task.**

## Cherry-pick onto AntiGravity's backend branch
Changed files: `functions/src/security/adminDashboardCatalog.ts`, `dashboardCatalogProjection.ts`,
`adminAuth.ts`, + the test. None are AntiGravity's collision files. `git cherry-pick <SHA>` is
clean unless their branch also edits these three security files; export names are unchanged, so
no `index.ts` / security-export edits are needed.
