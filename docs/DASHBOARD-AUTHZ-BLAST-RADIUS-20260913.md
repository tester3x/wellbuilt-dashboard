# Phase 5B0 — Authorization Blast-Radius Proof (READ-ONLY)

Scope: prove the EXACT current exposure of the Phase-5A `loadDashboardCaller` finding against **deployed** state before Phase 5B. No Functions/rules edits, no deploy, no production mutation. Dashboard held at `607fd2a1`.

## TL;DR — finding NARROWED to LOW (exploit DISPROVEN against deployed state)
- The repo's Phase-5A concern was: `loadDashboardCaller` derives authorization partly from client-writable inputs (`users/{uid}` roles/companyId in RTDB, `companies/{id}.roleCapabilities` in Firestore).
- **Deployed RTDB rules DENY client writes to `users/{uid}` (`.write:false`)** — the "forge roles/companyId" prerequisite is BLOCKED in production (emulator-proven). The repo `database.rules.json` that would allow it is STALE and is NOT what is deployed.
- The only Firestore-writable input (`companies.roleCapabilities` → a caps override) is **not consumed** by the authorization gate of any callable in the resolver's blast radius (they gate on `companyId`/`isPlatformAdmin`, which come from the write-protected `users/{uid}`).
- **Net: the concrete privilege-escalation chain is DISPROVEN against the current deployed system.** Residual is a code-hygiene / defense-in-depth risk (a *future* callable that gates on `caller.caps` would be escalatable if `companies.roleCapabilities` is client-writable) plus a **latent redeploy hazard** (the wide-open repo RTDB rules).

## 1. Deployed state — verified (not repo assumptions)
| Artifact | How verified | Result |
|---|---|---|
| **Deployed RTDB rules** | `firebase database:get "/.settings/rules" --project wellbuilt-sync` (read-only) → `docs/authz-evidence/DEPLOYED-rtdb-rules.json`, **sha256 `3475497484774F430974716330DF21580858F10098193BFC2D3C0D4E87299BF4`**, 6079 bytes | LOCKED DOWN: root `.read/.write:false`; **every node client-`.write:false`** (`users/{uid}`, `drivers/*`, `packets/incoming|outgoing`, `well_config`, …); reads keyed off `auth.token.wellbuiltAdmin`, `platformAdminEnabled`, `staffCompanyId`, `staffRole`. |
| **Repo `database.rules.json`** (firebase.json RTDB deploy target) | file read | STALE / wide-open: `{".read":true,".write":true}`. **Does NOT match deployed.** Deployed RTDB rules were shipped from another lane, not this repo. |
| **Repo `database.rules.secure.json`** | file read | A hardened variant, staged, `role`-based (RTDB `users/{uid}.role`), also `.write:false` — but NOT the firebase.json target and NOT the deployed ruleset either. |
| **Deployed Firestore rules** | NOT fetchable from this lane (`firebase firestore:rules` is not a command; gcloud absent) | **UNVERIFIED from this lane.** Repo `firestore.rules` (25KB, the firebase.json target) allows authenticated `companies/{id}` updates on non-protected keys; `roleCapabilities` is non-protected → client-writable under repo rules. Given the RTDB deploy target was stale, deployed Firestore rules must be confirmed via console/Rules API before relying on this. |
| **Storage rules** (repo `storage.rules`) | file read | `allow read, write: if true` (wide open). Off the authz path but a separate exposure. |
| **Compiled Functions w/ `loadDashboardCaller`** | source (`functions/src/security/adminAuth.ts`); deployed binary NOT decompiled | Deployed behavior UNVERIFIED. The deployed RTDB rules reference `staffCompanyId`/`staffRole` claims that the repo `loadDashboardCaller` does NOT read (it reads RTDB `users/{uid}` + `companies.roleCapabilities`), so deployed Functions may differ from repo. Treat repo resolver behavior as the worst-case model. |

## 2. Which identity fields are client-writable (deployed) — emulator-proven
Ordinary authenticated user (uid=`attacker`, no admin/staff claims):
| Input consumed by loadDashboardCaller/resolveCaps | Deployed RTDB rules | Stale repo rules |
|---|---|---|
| own `users/{uid}.companyId` | **DENIED (401)** | ALLOWED (200) |
| own `users/{uid}.roles` | **DENIED (401)** | ALLOWED (200) |
| another user's `users/{other}` | DENIED (write:false everywhere) | ALLOWED |
| `companies/{companyId}.roleCapabilities` (Firestore) | deployed rules UNVERIFIED from lane; repo firestore.rules ALLOWS (non-protected key) | n/a |

Evidence: `docs/authz-evidence/EMULATOR-RESULTS.md` + harness `docs/authz-evidence/emulator-harness/`. (Firestore `roleCapabilities` writability was not emulator-run because it is off the exploit path — see §3/§4 — and deployed Firestore rules are unverifiable from this lane.)

## 3. Exact callable blast radius (resolver consumers)
`loadDashboardCaller` (via `requireRegisteredDashboardUser`) is consumed by exactly THREE deployed callables — all in `functions/src/security/adminDashboardCatalog.ts`, all **READ-ONLY**:
| Callable | Required authority | Target company derivation | Client companyId accepted? | Authority gained | Extra protected/claim check | Forge impact |
|---|---|---|---|---|---|---|
| `adminGetWellPool` | registered user + `callerCanViewGlobalWellPool(caller)` | `caller.companyId` from `users/{uid}` (server) | No | READ global well pool / config / status | none beyond caller | RTDB forge blocked; gate ignores `caps` → roleCapabilities boost irrelevant |
| `adminGetWellHistory` | same + `canViewGlobalWellPool` | `caller.companyId` (server); `wellName` is client input (read scope only) | No (companyId); wellName yes | READ well pull history | none | same |
| `adminGetWellPerformance` | same | `caller.companyId` (server) | No | READ well performance | none | same |

Gate `callerCanViewGlobalWellPool(caller)` = `isPlatformAdmin || !companyId || companyId === liquid-gold` — depends ONLY on `companyId`/`isPlatformAdmin` (from write-protected `users/{uid}`), **NOT on `caller.caps`**. So the client-writable `roleCapabilities` cannot change these decisions.

Separately: the strong admin mutation callables (`adminUpdateCompanySafe`, plan/contract, archive, driver-bind, etc.) do NOT use `loadDashboardCaller` — they use `requireAdmin`→`authorizeAdminCall` (the un-forgeable `wellbuiltAdmin` claim + `platform_admins/{uid}` record). They are NOT in this blast radius.

## 4. Canonical identity source (verify the Phase-5B proposal)
- **A protected `companyId` custom claim does NOT exist for dashboard email-auth users.** Confirmed by `functions/src/security/__tests__/dashboardWriteInventory.test.ts:12-13`: "Dashboard email Auth has no wellbuiltAdmin/platformAdmin… or staffCompanyId claims."
- The `staffCompanyId`/`staffRole`/`wellbuiltAdmin`/`platformAdminEnabled` claims referenced by the deployed RTDB rules are minted for the **driver / SSO / staff-app** flows (`driverAuthCallables.ts:383`, `tokenMint.ts:125`, `ssoExchangeHandler.ts`) — the **identity lane**, not dashboard web.
- **However, an adequate canonical tenant source DOES exist for dashboard callables today:** `users/{uid}` (roles + companyId) is server-authoritative in production **because the deployed RTDB rules make it client-write-denied**. Phase 5B can treat `users/{uid}` as the canonical identity WITHOUT inventing a claim — provided the secure deployed RTDB rules remain deployed.
- **Do NOT enter the identity lane to mint a new `companyId` claim.** It is unnecessary (write-protected `users/{uid}` suffices) and is owned by another lane.

## 5. Confirmed / disproven / conditional
- **DISPROVEN (deployed):** "unprivileged user forges `users/{uid}` roles/companyId → escalates via `loadDashboardCaller`." Blocked by deployed RTDB `users/{uid}.write:false` (emulator-proven).
- **DISPROVEN (deployed blast radius):** "boost caps via `companies.roleCapabilities` → gain access on resolver callables." The 3 callables gate on `companyId`/`isPlatformAdmin`, not `caps`.
- **CONDITIONAL / defense-in-depth:** the repo resolver still mixes client-writable `roleCapabilities` into `caller.caps`. Any FUTURE callable that authorizes on `caller.caps` would be escalatable IF `companies.roleCapabilities` is client-writable (repo firestore.rules allow it; deployed unverified). Fix in Phase 5B: stop deriving authorization caps from `companies.roleCapabilities`.
- **CONDITIONAL — deployed Functions:** repo `loadDashboardCaller` may not equal the deployed binary (deployed rules imply a claim model). Confirm against the post-Watchdog baseline.

## 6. Severity & tenant impact
- **Current deployed severity: LOW.** No confirmed escalation path; the affected callables are read-only and gated by non-forgeable identity.
- **Latent HIGH (deployment hazard):** if anyone runs `firebase deploy --only database` **from this repo**, the wide-open `database.rules.json` OVERWRITES the secure deployed RTDB rules → instantly opens `users/{uid}` writes (and all RTDB) → the escalation prerequisite becomes live and packets/identity data become client-writable. This is the single most dangerous action in the deployment sequence.

## Existing secure exceptions (working correctly)
- Deployed RTDB rules: full client-write denial + claim-gated reads.
- Admin mutation callables: `wellbuiltAdmin` claim + `platform_admins/{uid}` record (un-forgeable) — unaffected.
- `users/{uid}` server-authoritative in production (write-denied).

## Required identity dependency for Phase 5B
Authorize the tenant company-update callable from **`users/{uid}` (server-written, write-protected) for roles + companyId**, and **do NOT derive authorization caps from `companies/{id}.roleCapabilities`**. No new custom claim is required (do not enter the identity lane). Keep `companyId` server-derived; reject client `companyId`.

## Safest deployment sequence (prevents lockout / app breakage)
1. **NEVER deploy RTDB or Firestore or Storage rules from this repo** — its `database.rules.json`/`storage.rules` are stale/wide-open and would regress production security. Rules are owned by their deploying lane; leave `--only database|firestore|storage` OUT of any dashboard release.
2. Fix the stale repo `database.rules.json` (make it mirror the deployed secure ruleset) as a SEPARATE, reviewed rules-lane change before it can ever be safely deployed — but not in a Hosting release.
3. Hosting releases stay **`--only hosting`** (Phase 4/5A procedure) — no rules, no functions.
4. Phase 5B Functions/rules work waits for the post-Watchdog live baseline; when hardening the resolver, deploy Functions BEFORE tightening any client-facing rules so callers aren't locked out mid-change, and emulator-prove the new resolver + rules together.

## Emulator regression
See `docs/authz-evidence/EMULATOR-RESULTS.md` + `docs/authz-evidence/emulator-harness/`. Demonstrates DENIED under deployed rules, ALLOWED under the stale repo file. No production calls, no real credentials, no customer data.
