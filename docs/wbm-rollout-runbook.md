# WB-M canonical pipeline — rollout & rollback runbook

Prepared by the predeployment safety gate (2026-08-30). **Operational
reference only — this document performs nothing.** Server candidate
`integration/wbm-backdated-chrono-reconcile` @ `901c00d` (the SEVEN-function
single reviewed HEAD, gate included), client
`integration/wbm-chrono-client-refresh` @ `19e4876`. Re-pin `--expect-sha` to
whatever `git rev-parse HEAD` reports at deploy time on this branch.

## Why a governed rollout (not "deploy all filtered quickly")

A filtered multi-function deploy is **not atomic**, and the old and new
pipelines have **incompatible concurrency models**: the old pipeline writes
`wells/<well>/status` as a **full-node `.set()`** (wiping `chronoLock` /
`chronoRevision`) with sequential non-atomic writes; the new pipeline uses a
per-well lock + one atomic multipath patch. Proven on the emulator
(`mixedVersion.mjs`, RACE2): an old operation acting on a well **after** a new
commit **regresses current** to the wrong pull. History is never lost, but
current/outgoing can disagree. Quiescence during the deploy window eliminates
the overlap.

## Rules landmine — hashes, guard, and prepared (unapplied) fix

- **Deployed (locked) rules** sha256 `5ba10f055a0673e151302b5f9b80ef6e38f006448acc8c7cd5bb47344899b314` — snapshot at `functions/emulator/fixtures/deployed-rules.json`.
- **Local OPEN `database.rules.json`** sha256 `9271065c0f8639df63cd998333cba5ec6bce20ca90c1f779e117410cf0c29cea` (`.read:true, .write:true`) — a dev stub that MUST NOT reach production.
- **Deployment guard** `functions/emulator/deployGuard.mjs` recognizes EXACTLY the two staged commands (Stage A producers, Stage C consumers) from one clean reviewed HEAD and REFUSES everything else: the seven- or six-function combined command, a bare/whole-codebase deploy, `--only functions:dashboard`, `database`/`hosting`, any function outside a stage set (or an excluded new export), a project other than `wellbuilt-sync`, a dirty tree, the wrong branch, `HEAD != --expect-sha`, or a HEAD whose built output is missing any of the 7 / whose `adminSubmitPullEdit` lacks the admission gate. Run it on the exact command before each stage:
  ```bash
  node functions/emulator/deployGuard.mjs '<the exact firebase deploy command>' --expect-sha <reviewed server SHA>
  ```
- **Prepared fix (do NOT apply without separate authorization):** align `database.rules.json` to the deployed locked ruleset by replacing its contents with `functions/emulator/fixtures/deployed-rules.json`. This is a **rules change** — out of scope for the functions-only deploy and left unapplied.

## Rules protection (verified — no rules change in this deploy)

The **deployed** RTDB rules already deny every client write to all
coordinator-owned state — `packets/{incoming,processed,rejected,outgoing,
incoming_version}` and `wells/$well/*` each resolve to `.write:false`, so the
new children (`incoming_revision_v2`, `editReceipts`, `chronoReceipts`,
`chronoLock`, `chronoRevision`) inherit denial. Proven by `rulesprobe.mjs`
(client SDK, 59/59 denied across unauth / driver / other-company / platform-
admin / staff; Admin SDK retains access). **The local `database.rules.json`
in this repo is OPEN (`.write:true`) — a dev stub. It MUST NOT be deployed.**

## Deploy manifest (exact — TWO staged commands — do not run here)

Single codebase `dashboard`. The rollout is **two** name-filtered commands from
the same reviewed HEAD, never one combined command. Run the deploy guard on
each exact string first.

**Stage A — gated producers (deploy while the gate is OPEN):**
```bash
firebase deploy --project wellbuilt-sync --only \
functions:ingestWbmPull,functions:ingestWbmEdit,functions:adminSubmitPullEdit
```

**Stage C — canonical consumers (deploy after the gate is CLOSED + drained + 180 s):**
```bash
firebase deploy --project wellbuilt-sync --only \
functions:processIncomingPull,functions:processEditRequest,functions:processDeleteRequest,functions:watchdogStrandedPackets
```

- A **name-filtered** function deploy touches only the listed functions and
  never deletes unlisted ones.
- **NEVER** deploy Stage A and Stage C as one combined command — the staged
  gate window (close → drain → 180 s) between them is what prevents the
  old/new concurrency regression (RACE2). The guard refuses the combined form.
- **NEVER** run `firebase deploy` (bare), `--only functions` (whole codebase),
  or `--only functions:dashboard` — the branch source is missing ~30 live
  functions (estimation-hold, split-leg, transfer, WB-T, JSA, hosting SSR, …),
  so a whole-codebase deploy would **prompt to delete them**. Never accept a
  deletion prompt.
- **NEVER** run `--only database` / `--only hosting` — the open local rules
  would clobber the safe deployed rules.
- New branch exports that must **not** deploy: `getGovernedWellConfig`,
  `staffHydrateCanonicalIdentity`, `staffRetireLegacyDriverLogin`,
  `recoverRejectedPull` (excluded by the stage name filters; the guard refuses
  any command that names one).

## Preflight

1. Confirm SHAs: server `901c00d` (re-pin to `git rev-parse HEAD`), client
   `19e4876`; both worktrees clean.
2. Confirm both deploy strings are the exact Stage-A and Stage-C name filters
   above, and that `deployGuard.mjs --expect-sha <HEAD>` ALLOWs each.
3. Confirm rules protection unchanged (deployed rules locked; do not deploy
   `database`).
4. `packets/incoming` **must be empty** (no active work): read-only
   `firebase database:get /packets/incoming --shallow`.
5. No active coordinator lock: read-only check that no
   `wells/<well>/status/chronoLock` exists.
6. Record current function revisions (`firebase functions:list`), current
   `incoming_version`, and a well-state checksum (hash of
   `wells/<well>/status/lastPull.packetId` across wells — no private data).

## Enforceable admission gate (Blocker-3 mechanism)

Quiescence is MECHANICALLY ENFORCED by a governed flag, not by operator
discipline:

- `system/maintenance/wbmMutations = { paused: true|false, reason, at, by }` —
  a **server-owned** path (deployed rules deny every client write; proven by
  `rulesprobe.mjs`). Only the deploy operator (Admin SDK / console) sets it.
- Every WB-M mutation **producer** checks it before writing `packets/incoming`
  and, when paused, refuses with a **retryable** callable code
  (`unavailable` / HTTP 503, message `wbm_mutations_paused`). The WB-M client
  classifies that as transient and **retains** the queued packet — never
  marks it sent/rejected, never falls back to a direct RTDB write.
- Gated producers, **all three now on this HEAD**: `ingestWbmPull`,
  `ingestWbmEdit`, and `adminSubmitPullEdit` (ported verbatim from Dashboard
  `9e9c837` with only the admission gate added; provenance in the commit
  message). All three form Stage A, so closing the flag covers **every**
  producer with no separate-branch dependency.
- The gate is checked **after** authorization (an auth failure stays an auth
  failure, never a maintenance error) and **before** writing `packets/incoming`.
- The flag **fails OPEN** (absent/malformed → admitted), so a missing flag can
  never wedge production.

Proven on the real emulator:
- `gate.mjs` (10/10) — the real `ingestWbmPull` callable: open→accepted;
  closed→retryable refusal with NO incoming write and no revision signal;
  already-accepted incoming still drains; retry-while-closed stays refused with
  the packet retained; reopen→the same packet id is accepted and materializes.
- `adminGate.mjs` (16/16) — the real `adminSubmitPullEdit` callable: gate
  missing/open→accepted; closed→retryable `UNAVAILABLE` with NO `edit_`
  incoming, no revision bump, no receipt, no processed/status change;
  reopen→accepted; distinct callable keys + equivalent material dedupe;
  different material→both events evidenced; auth failures stay auth failures
  (checked before the gate); the gate is server-owned and not client-forgeable.
- `stageA.mjs` (19/19) — the exact Stage-A window (new gated producers + the
  deployed OLD consumers built from `c7378d6`): old consumers accept and apply
  the new producer packet shapes; closing the gate stops all three producers;
  already-accepted old work drains; the old watchdog leaves no stranded work;
  the drain window stays quiescent.

## Staged rollout (server-first, gate-enforced, FAIL CLOSED)

The quiescence procedure is a fail-closed state machine — pure decision logic
in `functions/src/security/operational/rolloutStateMachine.ts`, unit-proven in
its `__tests__` (33/33, interruption after every transition):

```
OPEN → PAUSE_REQUESTED → DRAINING → DRAINED_180
     → CONSUMERS_DEPLOYING → VERIFYING → OPEN
```

Reopening to OPEN requires an affirmative `verify` (all four consumer revisions
match the reviewed build **and** no coordinator lock is held **and**
`packets/incoming` is empty). **Any** interrupt, timeout, read failure,
unknown revision, or failed consumer deploy from a closed state routes to
`HELD_CLOSED` — never auto-reopen. If anything goes wrong, the gate stays shut
and a human decides; the flag is never re-opened by a failure path.

Prepared (unexecuted) flag tooling: `functions/emulator/rolloutFlag.mjs` plans
each flag write and is DRY-RUN by default; it refuses an unexpected pre-existing
value (close only when OPEN/absent; reopen/confirm only when CLOSED; a malformed
flag is always refused) and refuses `--execute` from the harness — a production
flag write is a human operator action with service-account credentials.

**STAGE A — deploy the three gated producers, gate OPEN.**
Guard, then deploy `ingestWbmPull`, `ingestWbmEdit`, `adminSubmitPullEdit`
(the Stage-A command above) while `wbmMutations.paused` is false/absent. Prove
packet shape and normal behavior unchanged (a real pull still processes). No
trigger swap yet.

**STAGE B — CLOSE the gate, drain, wait (machine: PAUSE_REQUESTED → DRAINED_180).**
Set `wbmMutations = { paused: true, reason: 'rollout-<date>', at, by }` (plan it
with `rolloutFlag.mjs close --observed <read>`). Verify new submissions from all
three producers return the retryable maintenance code and are retained
client-side. Drain: confirm `packets/incoming` is empty and no
`wells/<well>/status/chronoLock` is held. **Wait ≥ 180 s** (120 s trigger
timeout + 60 s recovery margin) so no old commit-owning invocation remains. If
drain or the wait is interrupted, the machine is `HELD_CLOSED` — do not reopen.

**STAGE C — deploy the canonical triggers + watchdog (machine: CONSUMERS_DEPLOYING).**
Guard, then deploy `processIncomingPull`, `processEditRequest`,
`processDeleteRequest`, `watchdogStrandedPackets` (the Stage-C command above).
Watch the CLI plan: **abort** on any deletion, rules, hosting, or
unrelated-function action. A failed/partial deploy holds the gate closed.

**STAGE D — verify, reopen, monitor (machine: VERIFYING → OPEN only on full proof).**
Read-only health check (all four consumer revisions report the intended hash,
no lock held, incoming empty). Only then set `wbmMutations.paused = false`
(`rolloutFlag.mjs reopen --observed <read>`). Monitor the first genuine field
mutation end-to-end: receipt, chronological history, current state, both
revision signals, performance, production, outgoing, incoming deletion.

Success proof (read-only): the next pull writes a
`wells/<well>/chronoReceipts/<packetId>` receipt, advances
`wells/<well>/status/chronoRevision`, replaces `packets/incoming_revision_v2`,
and moves `packets/incoming_version` by exactly `1048576` per committed
mutation. vc25 clients refresh because their strict-greater comparison against
the persisted saturated value now passes (`incoming_version` finally moves).

Abort conditions: CLI proposes a deletion; a deploy error leaves a partial
function set; post-deploy a pull fails to produce a receipt.

## Post-rollout smoke (real driver activity, read-only verification — no test packets under this authorization)

- Newest CREATE → receipt + current advance + both revision signals.
- Truly older CREATE (backdated) → stored behind current, `lateEntry:true`.
- Equal-time CREATE → both survive, deterministic current.
- EDIT moving later → current promotes.
- DELETE → current recomputes.
- vc25 legacy refresh observed (a vc25 device syncs on the first commit).
- **No production repair/replay/reset** unless separately authorized.

## Rollback (data-safe, behavior-regressive)

Rollback = redeploy the previous (currently-deployed) legacy functions by the
same name filter. Data written by the new pipeline stays **readable** by the
old code (extra fields are additive; the old edit path recomputes from raw
fields). Constraints:

- **Quiesce and drain** first, exactly as for rollout.
- **Wait ≥ 180 s** so no new-pipeline worker holds a lease across the swap.
- The new `2^20` `incoming_version` increments remain compatible (old `+1`
  resumes; old clients still see monotone growth).
- New receipts / v2 nodes are ignored by the old server — harmless residue.
- **Re-enabled old defects:** watchdog local-key-as-UTC cloning, the
  20 BBL/ft tank-geometry hardcode, pre-commit partial writes, the frozen
  revision signal, timestamp-identity current selection.
- **Forward-fix-only case:** if **equal-time sibling rows** exist (created by
  the new canonical tie-break), the old time-only/iteration-order current
  selection can pick the wrong sibling after a delete — forward-fix rather
  than roll back in that state.
- Rollback is **prohibited** while any `chronoLock` is held or
  `packets/incoming` is non-empty (drain first).
