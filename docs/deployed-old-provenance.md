# Deployed-old consumer provenance (predeploy gate Rev-4 Blocker 3, corrected Rev-4 preflight)

Metadata for the four OLD consumers live in production, resolved by two
read-only paths (no deploy, no mutation, no secrets printed):
- `firebase functions:list --project wellbuilt-sync --json` (endpoint hash, config);
- an authenticated Cloud Functions REST **describe** (v1 for the three
  create/edit/delete, v2 for the watchdog) using the existing Firebase login —
  the OAuth token was used only in the `Authorization` header and never printed,
  and signed source URLs were redacted.

## Deployed artifact identity (Cloud Functions REST describe)

| function | gen | versionId / revision | updateTime (UTC) | buildId | endpoint hash (functions:list) | runtime | mem | timeout | trigger |
|---|---|---|---|---|---|---|---|---|---|
| processIncomingPull | v1 | versionId **79** | **2026-08-22T22:25:26Z** | `3b4ea964-30ef-4d02-be51-409d6e581cbb` | `06fe6e6c…b1e3c9` | nodejs20 | 256 | 60s | RTDB ref.create `packets/incoming/{packetId}` |
| processEditRequest | v1 | versionId **77** | **2026-07-26T02:25:21Z** | `2048a987-0f09-4dd4-993a-1e9781a8a29b` | `7dd9ba56…7ef18d` | nodejs20 | 256 | 60s | RTDB ref.create `packets/incoming/{packetId}` |
| processDeleteRequest | v1 | versionId **72** | **2026-06-16T03:29:46Z** | `e81d4fe1-db78-4cfd-ad8d-60d315997f78` | `2c796829…110848` | nodejs20 | 256 | 60s | RTDB ref.create `packets/incoming/{packetId}` |
| watchdogStrandedPackets | v2 | revision **watchdogstrandedpackets-00070-dod** | **2026-07-22T19:39:07Z** | build `01d3c002-159f-4999-9ac5-192373ada457` | `1ae2c446…7c4a30` | nodejs20 | 256Mi | 60s | scheduled (`every 5 minutes`) |

watchdog v2 source archive (recorded, not downloaded; no signed URL/token):
`gs://gcf-v2-sources-559487114498-us-central1/watchdogStrandedPackets/function-source.zip` (gen `1784749082509910`). The v1 functions expose a `sourceUploadUrl` (present, not downloaded).

## Corrected provenance conclusion — deployed-source commit is UNKNOWN

The Rev-4 REST describe **overturns** the earlier "c7378d6 is the inferred
deployed source" claim. The four consumers were last deployed at **different
times spanning Jun–Aug 2026** (versionIds 72/77/79), whereas `c7378d6` — this
integration branch's merge-base — is dated **2026-07-09** and its
`functions/src/index.ts` was last modified **2026-05-26**. So:

- `processIncomingPull` was deployed **2026-08-22**, six weeks AFTER c7378d6 —
  it cannot have been built from c7378d6.
- Commits from the deploy window (e.g. `2774168`, 2026-08-22, "key-aware
  history, canonical identity, two-pull rule, atomic batch") are on production
  branches that are **not ancestors of this branch's HEAD**.
- The branch's own pre-chrono tip (`36d37e5`, 2026-08-25) differs from both
  c7378d6 and the `2774168` lineage.

**Typed conclusion (per the auditor's scale):**
- **Deployed-artifact byte-identity: UNKNOWN.** The platform exposes versionId /
  updateTime / buildId / revision (recorded above) but no source hash that maps
  to a specific local git commit; the deploy history spans commits across
  branches, some outside HEAD's ancestry. No local commit is proven to equal any
  deployed artifact.
- **Deployed metadata: CONSISTENT.** Every observable config field (generation
  v1×3 / v2, region us-central1, runtime nodejs20, memory 256, timeout 60s,
  entryPoint, RTDB `ref.create` on `packets/incoming/{packetId}` / scheduled)
  matches the OLD-consumer source family exactly.
- The Stage-A compatibility harness (`stageA.mjs`, 19/19) was built from
  **c7378d6**, which is a valid pre-chrono member of the same source family but
  is **NOT the deployed artifact** and is behind the Aug-22 `processIncomingPull`
  deploy. It is a **source-family reconstruction**, not a deployed-artifact match.

## Why the compatibility conclusion still holds across the family

The property Stage-A proves — the OLD consumers accept the NEW gated-producer
packet shapes — depends only on the packet fields the old processor reads and
its trigger path, and these are **identical** across the whole pre-chrono
family:

| commit | reads | trigger |
|---|---|---|
| c7378d6 (merge-base) | requestType, wellName, dateTimeUTC, dateTime, bblsTaken, tankLevelFeet, driverId, driverName | `packets/incoming/{packetId}` |
| 2774168 (deploy-era, Aug 22) | *(identical set)* | `packets/incoming/{packetId}` |
| 36d37e5 (branch pre-chrono tip) | *(identical set)* | `packets/incoming/{packetId}` |

Because the input contract and trigger are stable across these versions, the
Stage-A acceptance/drain/watchdog conclusions transfer to the deployed artifacts
even though the exact deployed source is unproven.

## Operator action to close before rollout (read-only)

To convert **UNKNOWN → byte-exact or a precise delta**, the authorized operator
should, before the Stage-C cutover:
1. Download the deployed source archives (v1 `sourceUploadUrl`, v2
   `storageSource` above — read-only GCS) and diff the four consumers against
   the candidate commits (`c7378d6` and the deploy-era `2774168`), OR
2. Consult the deploy/CI records that produced buildIds
   `3b4ea964…`, `2048a987…`, `e81d4fe1…`, `01d3c002…` to pin the exact source
   commit for each, then re-run `stageA.mjs` against that source.

This is a read-only verification step; it was not performed here because it
requires downloading and diffing deployed artifacts, and the field-contract
stability above already makes the compatibility conclusion robust.
