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
- Deploy only through a canonical `release/dashboard-*` branch and the certified
  preflight (`scripts/preflight-hosting-deploy.cjs`): canonical branch + clean tree
  + descends from the proven UI baseline (`576fb63b`) + fresh build + guardrails.
- **Do not deploy merely to establish policy, docs, or test coverage.**
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
