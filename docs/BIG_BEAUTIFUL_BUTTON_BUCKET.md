# Big Beautiful Button Bucket

Inventory of Dashboard action buttons/controls being hardened onto governed,
narrowly-authorized server operations (replacing legacy direct client writes the
deployed Firestore/RTDB rules deny). Each item records the control, the old
(denied/partial) path, the governed replacement, its authorization, and status.

| # | Control | Location | Legacy path (problem) | Governed replacement | Auth | Status |
|---|---------|----------|-----------------------|----------------------|------|--------|
| 1 | **Backfill 12 Weeks** (diesel/FSC price history) | Billing → Fuel tab (`src/app/billing/page.tsx`) | `handleBackfillHistory` → `saveDieselPrice` loop: client `updateDoc(companies/{id}.currentDieselPrice)` denied (`companies .write:false`) → "Missing or insufficient permissions"; per-week loop left partial writes | `staffBackfillDieselPrices` callable — server fetches+validates EIA history, deterministic `${companyId}_${date}` ids (idempotent), **atomic batch** of all price rows + `companies.currentDieselPrice`; client via `src/lib/dieselBackfill.ts` | `editBilling` (it / admin / payroll); company from authenticated caller, never client-supplied | **Built, not deployed** — Functions `aeec0f0d` + client on Hosting lineage; deploy order: Functions callable first, then Hosting |

## Item 1 — Backfill 12 Weeks (detail)

**Diagnosis.** `saveDieselPrice` (`src/lib/billing.ts`) writes each week to
Firestore `diesel_prices` then updates `companies/{id}.currentDieselPrice`. The
company update is denied by the deployed rules (`companies .write:false`), so the
Backfill button surfaced "Missing or insufficient permissions" and — because the
company update runs after the per-week price writes — left partial state.

**Governed replacement.**
- Server callable `staffBackfillDieselPrices` (`functions/src/security/dieselBackfillCallable.ts`)
  + pure core (`functions/src/dieselBackfillCore.ts`).
- `editBilling`-gated (`requireEditBilling`, mirrors the client capability model:
  roles it/admin/payroll, per-company `roleCapabilities` overrides, `editBilling` claim).
- Company identity = `caller.companyId` (never client-supplied — only an optional
  bounded `weeks` is accepted). Region + FSC config loaded server-side.
- EIA history fetched + validated server-side; deterministic doc ids →
  idempotent replay; single atomic batch (prices + `companies.currentDieselPrice`)
  → no partial writes, no client company-config write, no rules broadening.
- Client rewire (`handleBackfillHistory`): calls the callable, disables duplicate
  submission, shows sanitized success/failure (`describeBackfillError`).

**Also fixed (same change, separate concern):** FSC initial-load hydration race —
the FSC Rate column now renders automatically once the billing configuration
resolves, with an explicit loading state while unresolved (no user interaction),
preserving `getFuelSurchargeRate` exactly.

**Related — not in scope here (report only):** the unauthenticated
`triggerDieselFetch` HTTP endpoint (current-week only, no auth) has no in-repo
consumers; the "Fetch from EIA" (single week) and manual "Save Price" buttons
share the same `saveDieselPrice` company-write and are future bucket items.
