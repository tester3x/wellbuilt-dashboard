# Dashboard Payroll/Billing Handoff — 2026-07-24

Desktop → laptop closeout for the shared completed-job contract.

## Commit / deployment proof

- Repo: `tester3x/wellbuilt-dashboard` — **deployed branch is `clean-rebuild`**
  (proven: hosting release 2026-07-23T05:01Z followed clean-rebuild's `86352ea` by 12 minutes;
  `main` is stale at `e69bfb6`, `wb-equipment/phase-1a` unchanged since Jul 13).
- Contract commit: **`a7ada1e`** — `fix(payroll-billing): share completed-job eligibility and service date`
  — fast-forward pushed to `origin/clean-rebuild`.
- Hosting deploy: **release 2026-07-24T05:18:18Z** to site `wellbuilt-sync`
  (<https://wellbuilt-sync.web.app>), static export from `out/`, deployed with
  `npx firebase deploy --only hosting` from the clean worktree.
- **No Cloud Functions deployment** from this work. **No historical Firestore writes.**
- Implementation worktree: `D:\dash-w` (clean checkout of clean-rebuild; kept on the desktop
  for future Dashboard work; the laptop should clone fresh instead).

## The contract (src/lib/payrollBillingContract.ts)

- `isPayrollBillingEligible(doc, tenant)` — THE inclusion decision for both consumers:
  open/cancelled/void never qualify; a scoped tenant sees exactly its own `companyId`
  (unstamped docs excluded from every scoped tenant, visible to platform admin);
  missing dates/operators never exclude a completed job. `PayrollEligible(J) == BillingEligible(J)`
  holds by construction.
- `invoiceServiceDate(doc, tz)` — canonical `date` first (offline replay never shifts it);
  marked **America/Chicago** createdAt fallback for legacy/undated docs (the old Billing fallback
  used the UTC day — off by one for evening closes); explicit `''` when no evidence.
  Rows carry `dateSource` (`invoice_date` | `created_at_fallback` | `none`) for diagnosis.
- `normalizeToYMD` shared (Billing's private copy removed); both consumers feed the same ymd
  into `getEffectiveRate` and diesel lookup.
- `MISSING_OPERATOR_LABEL` — Billing groups operator-less completed jobs under
  "⚠ Missing operator" at $0 instead of silently dropping revenue.
- Tests: `node scripts/test-payroll-billing-contract.mjs` — 6 sections, 10-fixture inclusion
  matrix (dated / undated legacy / missing companyId / cross-tenant / cancelled / void / open /
  missing operator / offline replay / split continuation).

## Dirty-WIP checkpoint (D:\dev\Dashboard — foreign security work, untouched otherwise)

- Branch: **`wip/dashboard-security-2026-07-24`** = `e638418` (pushed; base `5e5c0f3` on
  wb-equipment/phase-1a). RTDB security containment: rules + emulator tests + callables +
  deploy/rollback scripts + admin DriversTab rework. **Do not merge or deploy.**
- **Security exception:** `functions/_phase1-deployed.json` (raw deployed-functions inventory)
  embeds live Cloud Functions env config **including an Anthropic API key** — GitHub push
  protection blocked it; the branch carries `functions/_phase1-deployed.sanitized.json`
  (env config redacted) instead. The raw file remains local-only on the desktop at
  `D:\dev\Dashboard\functions\_phase1-deployed.json`. **Recommend rotating that Anthropic key**
  regardless — it also lives in plaintext in the Cloud Functions env config it was captured from.
- Local-only leftovers in `D:\dev\Dashboard` (intentionally uncommitted): that raw JSON,
  `database-debug.log` (emulator log), `rtdb-rules-tests/node_modules`.

## Laptop resume

```bash
git clone https://github.com/tester3x/wellbuilt-dashboard.git
cd wellbuilt-dashboard
git checkout clean-rebuild        # deployed line; contract lives here (a7ada1e)
npm ci
node scripts/test-payroll-billing-contract.mjs
# WIP review only:
git checkout wip/dashboard-security-2026-07-24
```

Firebase deploys require `firebase login` (interactive) on the laptop; no env values are stored in git.
