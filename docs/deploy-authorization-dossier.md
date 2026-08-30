# WB-M rollout — deployment-authorization dossier (Rev-4 final preflight)

**Prepared read-only. Nothing here is authorization. No deploy, flag write,
production write, push, replay, rules change, APK, or device action was
performed.** Reviewed server HEAD `f6d90afbb35b20ae793f8280cdbd23c94dba1122`
(materially the `c3fc989…` candidate — the delta is docs/emulator tooling only;
no `functions/src/` change, 7-function build byte-identical). Client HEAD
`3f418397ede895c43e85bc725e8c4f85c836ed53` (unchanged).

## 1. The intentionally skipped guarded E2E test — identified and executed

- **Test:** `it('live trigger writes processed/outgoing/well status under
  20260820_124211_Gabriel1_frr2t3')`
- **Suite:** `describeFunctionsE2E('functions emulator: processIncomingPull
  keeps the ingest child key')` in
  `functions/src/security/operational/__tests__/wbmPullCanonicalId.emulator.e2e.test.ts`
- **Why it was skipped under `suites`:** gated on `hasFunctionsTrigger =
  hasEmulator && process.env.WBM_FUNCTIONS_E2E === '1'`; the `suites` run mode
  is `--only database` and does not set that env, so the block is `describe.skip`.
  Its mutually-exclusive sibling `describeE2E` (the pure, no-live-trigger
  variant) runs instead and asserts the same canonical-id property.
- **Category:** it is a CREATE-path case. Rather than argue non-required, it was
  **executed** under the functions emulator (`node functions/emulator/run.mjs
  canonicalid`, which starts `functions,database,firestore` with
  `WBM_FUNCTIONS_E2E=1`): the live `processIncomingPull` trigger wrote
  processed/outgoing/well status under the exact ingest child key — **1 passed**.
  No required CREATE/EDIT/DELETE, retry/replay, crash/fence, 180s-horizon,
  cross-date, non-20-BBL/ft, or multiple-tank case is left unexecuted (those are
  covered by `harness` 64, `faults` 27, `mixed` 7, `stagea` 19, `drainrace` 11,
  and the guarded `suites`).

## 2. Deployed-consumer provenance (authenticated read-only REST describe)

See `docs/deployed-old-provenance.md`. Real artifact identifiers (Cloud
Functions REST; token never printed):

| function | gen | versionId / revision | updateTime | buildId |
|---|---|---|---|---|
| processIncomingPull | v1 | 79 | 2026-08-22T22:25:26Z | `3b4ea964…` |
| processEditRequest | v1 | 77 | 2026-07-26T02:25:21Z | `2048a987…` |
| processDeleteRequest | v1 | 72 | 2026-06-16T03:29:46Z | `e81d4fe1…` |
| watchdogStrandedPackets | v2 | `…-00070-dod` | 2026-07-22T19:39:07Z | `01d3c002…` |

**Typed conclusion: deployed-artifact identity UNKNOWN; deployed metadata
CONSISTENT.** The consumers were last deployed at different times (Jun–Aug
2026); `c7378d6` (branch merge-base, 2026-07-09) is NOT the deployed source
(processIncomingPull deployed six weeks later), and deploy-era commits like
`2774168` are not ancestors of HEAD. The Stage-A harness (built from `c7378d6`)
is a **source-family reconstruction**; its compatibility conclusion holds
because the old processor's read fields and trigger path are identical across
`c7378d6` / `2774168` / `36d37e5`. Operator step to reach byte-exact: download
the deployed source archives (recorded) or consult the buildId CI records, then
re-run `stageA.mjs` against that source.

## 3. Dry-run against the real project (read-only; no --execute, no flag write)

Controller `plan` and `preflight` (project `wellbuilt-sync`):

- **local server HEAD / parent:** `f6d90afbb35b20ae793f8280cdbd23c94dba1122` /
  `c3650dde34600305afa283a8acf5f2af2aec1c58`
- **clean-worktree:** yes (server 0, client 0; ignored `functions/lib` excluded)
- **excluded-commit ancestry:** `1d932b8`, `b3024ed`, `40afc77`, `f24d260` — all
  non-ancestors
- **current deployed function identities:** §2 (consumers) + producers —
  ingestWbmPull `ingestwbmpull-00002-fes` (build `acb41d76…`, 2026-08-22),
  ingestWbmEdit `ingestwbmedit-00001-fub` (build `ff1f2316…`, 2026-08-26),
  adminSubmitPullEdit `adminsubmitpulledit-00002-bux` (build `20212855…`,
  2026-08-23); all v2, 30s/256Mi, nodejs20
- **current maintenance-flag value:** `null` (OPEN/absent — producers admit)
- **incoming / edit / delete queue counts:** `packets/incoming` = **0** (empty;
  edit/delete are a requestType subset of incoming → 0)
- **active coordinator locks:** **0** across **82** wells; **0** chrono
  artifacts (no chronoRevision/chronoReceipts) — consistent with the chrono
  pipeline being undeployed
- **rules/version identity:** live RTDB rules normalized-JSON **==** the
  committed fixture `functions/emulator/fixtures/deployed-rules.json` (raw
  sha256 `5ba10f05…4899b314`); live root `.write:false` (LOCKED). rulesprobe
  72/72 validates that ruleset denies every client write.
- **incoming_version:** `4.3005353146607763E20` (saturated; the 2^20 sentinel
  still moves it)
- **proposed Stage A command:** `firebase deploy --project wellbuilt-sync --only
  functions:ingestWbmPull,functions:ingestWbmEdit,functions:adminSubmitPullEdit`
- **proposed Stage C command:** `firebase deploy --project wellbuilt-sync --only
  functions:processIncomingPull,functions:processEditRequest,functions:processDeleteRequest,functions:watchdogStrandedPackets`
- **confirmation token the controller requires:** `4530c39daca5ddc1f054f67e`
  (bound to rolloutId `rollout-preflight-f6d90afb` + this SHA + project)
- **journal:** `functions/tools/.rollout-journal/rollout-preflight-f6d90afb.json`
  — initial state **OPEN**, history `[preflight_ok]`

## 4. Rollback material (currently deployed identities to restore to)

| function | current deployed revision/version (rollback target) | build |
|---|---|---|
| ingestWbmPull | `ingestwbmpull-00002-fes` | `acb41d76…` |
| ingestWbmEdit | `ingestwbmedit-00001-fub` | `ff1f2316…` |
| adminSubmitPullEdit | `adminsubmitpulledit-00002-bux` | `20212855…` |
| processIncomingPull | versionId `79` | `3b4ea964…` |
| processEditRequest | versionId `77` | `2048a987…` |
| processDeleteRequest | versionId `72` | `e81d4fe1…` |
| watchdogStrandedPackets | `…-00070-dod` | `01d3c002…` |

Source recoverability (no push; local only):
- **Candidate source** (the seven functions being deployed): server HEAD
  `f6d90af` on `integration/wbm-backdated-chrono-reconcile`, 7-function build
  byte-identical to the reviewed `c3fc989`.
- **Reconstructed old-consumer source:** commits `c7378d6` (merge-base),
  `2774168` (deploy-era), `36d37e5` (branch pre-chrono tip) are all present
  locally; the built old lib is at
  `functions/emulator/.stagea-old-consumers/functions/lib/` (rebuildable via the
  `stagea` prep).
- **Stage-C rollback in practice:** the consumers are untouched until Stage C —
  aborting before Stage C leaves production wholly on the current pipeline. If
  Stage C must be reversed, redeploy the current consumer source (versionId
  79/77/72 + watchdog `…-00070-dod`); their exact source is recoverable from the
  deployed source archives (recorded in `deployed-old-provenance.md`).

## 5. Operator timeline (sequence only — nothing executed)

A. **Stage A** — deploy the three gated producers (guard-checked command
   above). Producers keep writing to `packets/incoming`; behavior is unchanged
   except each now honors the admission flag.
B. **Verify producers** — confirm the three producer revisions advanced to the
   reviewed build (read-only describe).
C. **Settle** — allow deploy propagation and in-flight producer work to drain
   normally (gate still OPEN).
D. **CAS-close** the flag — `system/maintenance/wbmMutations` → CLOSED via the
   controller's atomic transaction (rolloutId + reviewed SHA + server
   timestamp). From here every producer returns retryable maintenance and the
   client retains its packet.
E. **Drain + horizon** — confirm `packets/incoming` stays empty, no lock is
   held, and no new watchdog keys appear **continuously for the full 180 s**
   (120 s trigger timeout + 60 s margin). A one-shot empty snapshot is
   insufficient (proven by `drainrace`).
F. **Stage C** — deploy the four canonical consumers (guard-checked command
   above). Watch the CLI plan; abort on any deletion/rules/hosting action.
G. **Reconcile partial Stage C** — inventory the four live consumer revisions;
   a CLI exit code is not trusted. If any is missing/mismatched, forward-deploy
   it or remain HELD_CLOSED — never reopen.
H. **Verify consumers + health** — all four revisions match the reviewed build,
   incoming empty, no lock.
I. **Reopen** — only after every verification passes, CAS-reopen the flag (same
   rolloutId + SHA).
J. **Fail-closed** — on any ambiguity, exception, refused CAS, or failed/partial
   deploy: HELD_CLOSED, admission left closed, print recovery, do not reopen.

**What WB-M users experience while the flag is CLOSED (D–I):** new pull/edit
submissions from the field phones return a retryable maintenance response
(`unavailable`/HTTP 503, `wbm_mutations_paused`). The client classifies this as
transient and **retains** the queued packet (never marks it sent, never
rejects it, never falls back to a direct RTDB write) — pinned by the client
`ingestRefusal` unit test. Users can keep working; their submissions queue on
the device. **After reopen (I):** the retained packets are re-sent with their
original ids; the new canonical consumers process them idempotently (the
content-derived ids dedupe retries), so no pull is lost or double-counted. The
window is a few minutes (Stage-C deploy + 180 s + verify).

## 6. Final authorization request — see the authorization block

Assembled in the session response and reproduced from this dossier. It names
the project, exact SHA, seven functions, the two deploy commands, the two flag
transitions, the 180 s clean drain, the confirmation token, the rollback
targets, and the prohibited actions. **This dossier does not itself authorize
anything.**
