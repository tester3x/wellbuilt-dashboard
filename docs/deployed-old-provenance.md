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

## Deployed-artifact download, hashes, and compatibility (final preflight item 2)

The deployed source bundles for ALL SEVEN functions were downloaded read-only
(v1 via Cloud Functions `generateDownloadUrl`; v2 via the GCS `storageSource`
JSON API — tokens and signed URLs never printed), SHA-256'd, and extracted to a
non-repository rollback directory. Each contains `package.json`, compiled
`lib/index.js`, `src/`, and `package-lock.json` (firebase-functions ^7.0.5); no
`node_modules` (Cloud Build installs them) — readable and redeployment-sufficient.

| function | gen | deployed id | archive SHA-256 | bytes |
|---|---|---|---|---|
| processIncomingPull | v1 | versionId 79 | `ad824ef04eb56011fe56f5ce70e48d2998f427b07574b82cbedc99b2b14b2d99` | 1,754,905 |
| processEditRequest | v1 | versionId 77 | `cf3c03d5cce19df93dfdaf6c062c0c0591c4c8f17a34c5c12dd3526e8d26f252` | 805,398 |
| processDeleteRequest | v1 | versionId 72 | `708b33adf1adf3df8c4e1e072cdc98e63a6537c96cfadb86b2384736713c33bb` | 13,959,198 |
| watchdogStrandedPackets | v2 | obj gen 1784749082509910 | `d3e0fc135183ad86ff5e8ef7599d8e935b903b3bd101e34df6b2c17ae3aab59e` | 777,255 |
| ingestWbmPull | v2 | obj gen 1787441787281543 | `097a1233733966019ba8794f3b6908c01208527bc6d209db3a0626c055b42df0` | 1,754,650 |
| ingestWbmEdit | v2 | obj gen 1787724935413483 | `d895b907fd67acffc50073c3c1285d32ad1e804502386759a5440f270703cf3f` | 1,784,302 |
| adminSubmitPullEdit | v2 | obj gen 1787445498852255 | `f6a06a70b350438f7cf26a7428b99aa8c934e09439caa3ba9951dd5885b81f41` | 1,762,065 |

The four deployed **consumer** libs each load, export their function, and
register the correct trigger (`packets/incoming/{packetId}` ×3; scheduled
watchdog). Composing the four exact deployed consumer libs (each from its own
archive) and re-running the Stage-A mixed-generation harness against them
(`WB_OLD_LIB=<composite>`): **ALL 19 pass** — the actual deployed consumer code
accepts and applies the new gated-producer packet shapes, already-accepted work
drains, incoming empties, and the deployed watchdog leaves no stranded work.

**Upgraded typed conclusion:** the deployed-consumer compatibility is now proven
against the **exact deployed artifacts** (downloaded, byte-hashed, and executed
in the emulator), not merely the `c7378d6` source family. The archive SHA-256s
above are the byte-identities of the deployed source bundles; they are the
authoritative rollback sources. The `c7378d6` reconstruction remains valid
secondary evidence (the packet field-contract is identical across the family).
Residual nuance: the archive is the deployed **source** bundle for the active
revision; the running container is Cloud-Build-produced from it (adds
node_modules) — the source `lib/index.js` is the authoritative code and is what
the proof exercised.

Reproduce (read-only): download via the API paths above → extract → junction
`node_modules` → compose the four consumer exports → `WB_OLD_LIB=<composite>
node functions/emulator/run.mjs stagea`. Archives are NOT committed (large;
deployment artifacts).
