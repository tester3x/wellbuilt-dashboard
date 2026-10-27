## Expo/EAS build authorization — all apps, both computers

- Batch fixes and features into substantial updates. Do not create cosmetic-only builds.
- Never start an Expo/EAS cloud build unless Mike specifically requests that build in the current work. A significant batch of changes alone is not authorization.
- This applies to every app, computer, build profile and platform, including builds started through scripts, CI, API calls or expo.dev. Do not launch additional builds or retries unless the explicit request covers them.
- Earlier blanket permission to build/install, autonomous-work instructions and old build requests do not authorize new builds under this policy.
- Continue coding, local validation, tests, commits and pushes while updates accumulate. Keep work preserved without spending cloud-build credits.
- Urgent fixes have no automatic exception: explain the need and wait for Mike's explicit build instruction.

# AGENTS.md — WellBuilt Dashboard working & release discipline

Standing policy for any agent/engineer working in this repository. Merge additions;
do not overwrite existing instructions.

## 1. Preservation & checkpoints
- Commit and push meaningful checkpoints **throughout** work, not only at the end.
- Before stopping, handing off, or switching computers, create a clearly labeled
  **WIP checkpoint commit and push it**. Never stop with unpushed local work.
- Never `git reset --hard`, discard, or `stash`-and-forget work; never overwrite or
  delete another checkout's changes. Do not touch other people's WIP branches
  (e.g., Laptop's WB-E / WB-S branches).
- On a push failure, **report it and state the exact preserved local commit SHA** so
  the work can be recovered; do not retry destructively.

## 2. Never commit
Credentials/secrets/API keys; customer or payroll data; real scans/photos; device
logs; generated builds (`out/`, `.next/`, `node_modules/`); and unrelated work. Keep
each commit scoped to one concern.

## 3. Branch hygiene
- No force-push, no silent reset, no discarding others' changes.
- Starting on another computer: **`git fetch` first, then verify branch, HEAD, and
  upstream** before editing. Do not assume a previously-known SHA is still current.

## 4. State vocabulary — keep these DISTINCT facts
Report each separately; never conflate them:
- **committed** (in local history) · **pushed** (on origin) · **built** (compiles /
  `next build` succeeds) · **installed** (on a device) · **deployed** (live on
  Hosting) · **verified** (externally proven — e.g., live byte-match / passing
  regression).
- Record the **exact source commit** with every build and every deployment.

## 5. Release discipline (Hosting)
- Use `npm run deploy:hosting`. Preflight must freshly fetch and include
  `origin/release/dashboard-approved-base`, and HEAD must exactly match its pushed
  release branch. Missing/unreachable origin or a stale/divergent branch blocks
  deployment. Merge the shared checkpoint; never reset away local work.
- Firebase's Hosting postdeploy hook verifies every exported file against live
  bytes before advancing the shared checkpoint with a normal fast-forward push.
  A mismatch or checkpoint race is a failed release requiring investigation,
  even if Firebase uploaded successfully. Do not bypass hooks or manually advance
  the checkpoint to make a failing deployment pass.
- Preflight acquires a shared remote Hosting lock after its tests, preventing
  overlapping compliant deployments. Failed uploads/verification deliberately
  retain the lock. Investigate the live release and recorded lock owner before
  clearing an abandoned lock; never delete another running release's lock.
- Add a meaningful retained-behavior regression to the mandatory preflight when
  fixing a release regression. Ancestry alone does not detect later reverts.
- Deploy only through a canonical `release/dashboard-*` branch and the certified
  preflight (`scripts/preflight-hosting-deploy.cjs`): canonical branch + clean tree
  + descends from the proven UI baseline (`576fb63b`) + fresh build + guardrails.
- A policy, docs, or test-only change does not itself trigger a Hosting release; carry user-requested product code changes through the verified, scoped release path under the current workspace policy.
- Before a release, run the previously approved regression checks
  (`tools/test-header-navigation-guardrails.mjs`, `tools/test-photo-review-contract.mjs`,
  `tools/test-render-all-authenticated-routes.mjs`, plus the `src/lib/__tests__`
  suites) and confirm the release commit **includes** all previously approved
  Dashboard repairs and the intended new work.
- After deploy, **prove the live artifacts byte-match the built source** and record
  the deployed commit + timestamp.
- **Never deploy `--only database|firestore|storage` rules from this repo** — the
  repo `database.rules.json`/`storage.rules` are stale/wide-open and would regress
  the (more secure) deployed rules; rules are owned by their deploying lane.

## 6. Lane boundaries
Frontend/Dashboard work does not edit Functions, Firestore/RTDB/Storage rules, auth,
claims, or identity unless the task explicitly scopes it. Do not merge or modify
other applications' branches (WB-E, WB-S, WB-M, WB-T, WB-P, WB-B, JSA) or the
Watchdog lane.
