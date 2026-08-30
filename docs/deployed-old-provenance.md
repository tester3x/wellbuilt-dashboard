# Deployed-old consumer provenance (predeploy gate Rev-4 Blocker 3)

Read-only production metadata for the four OLD consumers that remain live during
the Stage-A window, resolved via `firebase functions:list --project
wellbuilt-sync --json` (no deploy, no mutation, no secrets printed). Reproduce
with `node functions/tools/deployedProvenance.mjs`.

## Deployed metadata vs the reconstructed source `c7378d6`

| function | gen | region | runtime | memory | timeout | entryPoint | codebase | deployed endpoint hash | c7378d6 metadata |
|---|---|---|---|---|---|---|---|---|---|
| processIncomingPull | gcfv1 | us-central1 | nodejs20 | 256 | 60s | processIncomingPull | dashboard | `06fe6e6c6535accfc47d18a362738c20b8b1e3c9` | **consistent** |
| processEditRequest | gcfv1 | us-central1 | nodejs20 | 256 | 60s | processEditRequest | dashboard | `7dd9ba568c883ddce2a32f6421d933bc847ef18d` | **consistent** |
| processDeleteRequest | gcfv1 | us-central1 | nodejs20 | 256 | 60s | processDeleteRequest | dashboard | `2c7968291b69ce4866eb025938b5828dd5110848` | **consistent** |
| watchdogStrandedPackets | gcfv2 | us-central1 | nodejs20 | 256 | 60s | watchdogStrandedPackets | dashboard | `1ae2c44667d6bfe96f14ff00fa0cf412757c4a30` | **consistent** |

watchdog v2 source archive (recorded, not downloaded — read-only, no signed URL/token):
`gs://gcf-v2-sources-559487114498-us-central1/watchdogStrandedPackets/function-source.zip` (gen `1784749082509910`).

Trigger shapes (from `functions:list`): the three create/edit/delete consumers
are **gcfv1** `providers/google.firebase.database/eventTypes/ref.create` on
`packets/incoming/{packetId}`; the watchdog is **gcfv2** scheduled (`every 5
minutes`). Both match the `c7378d6` source exactly (`functionsV1.database.ref(...)`
× 3 + `functionsV2.onSchedule('every 5 minutes', …)`).

## Dependency identity

The Stage-A mixed bundle builds the old consumers from `c7378d6` source. Its
runtime dependencies are **byte-identical** to the `c7378d6`
`functions/package-lock.json`:

| dep | c7378d6 lockfile | build actually used |
|---|---|---|
| firebase-functions | 7.0.5 | 7.0.5 |
| firebase-admin | 13.6.0 | 13.6.0 |
| typescript | ^5.9.3 | ^5.9.3 |

The four consumers import only `firebase-functions` (v1/v2), `firebase-admin`,
and two local `./canonical-jobs/*` modules that are part of the `c7378d6`
source itself (zero `@tester3x/wellbuilt-contracts` imports), so the dev-dep
differences (jest/ts-jest, the contracts mirror) cannot affect their compiled
behavior.

## Classification (honest)

**SOURCE-IDENTICAL to `c7378d6`, with the exact old runtime dependency
versions, and every observable deployed metadata field consistent.**

Not claimed: **deployed-artifact BYTE-IDENTITY is UNPROVEN.** `gcloud` is not
available in this environment and `functions:list` exposes no `updateTime` /
`versionId` and no downloadable v1 source archive, so firebase's deploy-time
source hash cannot be reproduced locally (it is not a plain sha256 of the
source; it comes from the deploy packaging pipeline). The deployed endpoint
hashes above are **recorded** so a future authorized run (with `gcloud
functions describe` or a scratch-project rebuild) can complete the exact
comparison.

**Deploy-lineage is INFERRED, not proven:** `functions:list` does not report
the git commit that produced the live artifact. `c7378d6` is taken as the
deployed pre-chrono source because it is this integration branch's merge-base
(the branch point before the chrono rewrite) and every observable field
matches. If the operator can run `gcloud functions describe` or download the
source archives, upgrade this to BYTE-IDENTICAL or record the precise delta
before rollout.

Because the Stage-A compatibility proof (`functions/emulator/stageA.mjs`, 19/19)
runs the consumers built from this exact source + exact runtime deps, it is a
**source-exact reconstruction**, not merely a behavioral one — but it inherits
the same deployed-artifact-identity limitation stated above.
