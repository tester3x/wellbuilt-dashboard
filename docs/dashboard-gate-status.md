# Dashboard completion-gate status (predeploy gate Blocker 4)

> **Rollout-blocker status (Rev-3): CLOSED.** The staged rollout now targets
> **seven** functions from **one** reviewed clean HEAD, deployed as **two**
> commands (Stage A producers, then Stage C consumers) — see
> `wbm-rollout-runbook.md`. The previously-missing governed producer
> `adminSubmitPullEdit` was ported verbatim onto this branch (provenance:
> Dashboard `9e9c837`) with only the admission gate added, and is exercised as
> a real callable (`functions/emulator/adminGate.mjs`, 16/16). The Stage-A
> mixed generation (new producers + the deployed old consumers) is proven in
> `functions/emulator/stageA.mjs` (19/19). This section is therefore the ONLY
> remaining red, and the narrow deployment-scope waiver below is now in scope.

**The Dashboard gate is NOT green** and is not claimed green. Every remaining
failure is pre-existing (byte-identical at `cdf8635`, the parent of the WB-M
review-surface commit) and lives entirely in the Dashboard app (`src/…`) or
the contracts vendoring — **none touch the seven staged deploy functions
(Stage A: `ingestWbmPull`, `ingestWbmEdit`, `adminSubmitPullEdit`; Stage C:
`processIncomingPull`, `processEditRequest`, `processDeleteRequest`,
`watchdogStrandedPackets`), shared functions code, or the functions TypeScript
build (which is ZERO).**

Deploy-relevant invariant that IS green: `functions/` TypeScript compiles with
zero errors, `npm ci && npm run build` in `functions/` succeeds, and the
vendored contracts mirror verifies (`verifier passes on the committed mirror`;
`every mirror file matches its manifest hash`).

| test / error | exact failure | pre-existing (cdf8635)? | touches the 6 deploy fns / shared fns code? | affects functions compile / package discovery / predeploy? | safest source-only repair | expands WB-M scope? |
|---|---|---|---|---|---|---|
| `tools/test-createSecureLoginUi` (14) | secure-login request-builder / handler-slice assertions resolve to −1 | yes, identical | no — Dashboard `src/lib` secure-login UI | no | update the secure-login UI decision-layer source those assertions pin | yes (secure-login, unrelated) |
| `tools/test-employeePanelSecureLogin` (3) | "exactly one submit handler", success-copy, session-secured assertions | yes, identical | no — Dashboard `src/` employee panel | no | align the employee-panel secure-login source | yes (secure-login) |
| `tools/test-secureLoginProvisioning` (4) | provisioning copy + `staffConvertApprovedDriverSecureLogin` handler slice not found | yes, identical | no — Dashboard `src/` provisioning UI | no | align the provisioning UI source | yes (secure-login/provisioning) |
| `tools/test-dvirProtocolSchemaGap` (1) | expects the contracts **0.2.0** protocol surface (160 exports); branch ships 0.4.0 | yes, identical | no — checks the client contracts package export shape | no (contracts are vendored + verified for functions) | regenerate the DVIR schema test against 0.4.0, or bump the expected surface | yes (contracts/DVIR) |
| `tools/test-functionsDeployBoundary` (5) | manifest "pins published source sha256 / npm integrity / name+version / identity" | yes, identical | boundary-adjacent, but the mirror **verifies + builds**; these are upstream-provenance pins | no — the mirror files match the manifest; `npm ci`+build works | regenerate the mirror manifest with upstream GitHub-registry published hashes (needs registry fetch) | yes (contracts vendoring/provenance) |
| `src/lib/notifications.ts` tsc | `Record<UserRole,…>` missing `safety`, `lead` (contracts 0.4.0 added roles) | yes, identical | no — **Dashboard (Next.js) app** build, not `functions/` | no — separate tsconfig from the functions build | add `safety`/`lead` entries to the `NotificationCategory` role map | yes (Dashboard notifications) |

## Determination

- None of the six is **directly affected by the WB-M deployment surface** (the
  seven staged functions) or **shared functions code**. The functions build is zero;
  the contracts mirror verifies and builds; the predeploy hook
  (`npm --prefix functions run build`) succeeds.
- `test-functionsDeployBoundary` is the closest-to-relevant (it concerns the
  functions deployment boundary), but its 5 failures are **upstream-provenance
  pins** on the vendored contracts manifest — the mirror itself is internally
  consistent and builds, so the actual functions deploy is unaffected. Fixing
  them means regenerating the contracts mirror manifest against the GitHub
  Packages registry — a contracts-vendoring task **outside WB-M scope** that
  was already failing before any WB-M work.

## Requested waiver (narrow, deployment-scope)

With the rollout blocker closed, the scope of this waiver is now well-bounded.
Because all six failures are pre-existing (byte-identical at `cdf8635`),
Dashboard-app-scoped (or contracts provenance), and provably do not affect the
WB-M functions deploy — the functions TypeScript build is ZERO, the vendored
contracts mirror verifies + builds, the predeploy hook succeeds, and the
deploy guard (`functions/emulator/deployGuard.mjs`) recognizes only the two
staged commands from this clean HEAD — we **request a narrow Mike waiver
scoped to exactly the six pre-existing Dashboard/contracts failures** for this
WB-M deploy, rather than expanding WB-M scope into Secure Login, DVIR,
provisioning, notifications, or contracts-vendoring source.

The waiver is explicitly NOT a blanket gate bypass: it does not cover any
functions-build regression, any change to the seven staged functions or shared
functions code, or any new failure. If any of those turn red, the waiver does
not apply and the deploy must stop.
