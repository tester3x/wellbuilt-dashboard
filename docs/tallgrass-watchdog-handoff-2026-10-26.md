# Temporary laptop Watchdog handoff

## Source and deployment

The laptop branch `codex/watchdog-tallgrass-laptop-20261026` retains the previously deployed intake/parser baseline from `codex/watchdog-combined-time-20261019`. Product checkpoint: `5c8333ce`.

- Accept Granli's observed Grenli/Granil spelling variants only when Granli is in the authorized catalogue.
- Accept a standalone pad/CTB suffix on a known well heading.
- Resolve the official operator for newly created wells from unique API/name matches in active and inactive NDIC catalogues. This remains server-owned metadata.
- Only `ingestWatchdogPullV2` and `staffWriteWellConfig` were deployed. Both report ACTIVE. No Hosting or security rules deployment.

Validation: functions TypeScript build passed; 117 focused parser/import/operator/config tests and 66 worker tests passed. An additional legacy intake suite retains six pre-existing decimal-versus-feet/inches fixture failures; do not describe the full repository test suite as passing.

## Temporary receiver

The local receiver runs hidden, with its own linked WhatsApp session and durable private queue, at `http://127.0.0.1:8791/`. Its data directory is under `%LOCALAPPDATA%/WellBuilt/WhatsAppWatchdog-Tallgrass-live-20261026`. Only the Tallgrass group is enabled locally; the home HP's existing groups were not changed.

The worker was restarted onto the product checkpoint and verified Connected, Watching, with WB M Ready and current receiver checks. A new written-barrel load completed through the authenticated receiver and the owner confirmed its arrival in WB M. The queue survives restart; do not copy a live browser profile or run competing receivers for this group during the future HP handoff.

## History and configuration

The owner-supplied export was normalized with original message bodies retained losslessly, previewed and applied through the governed owner import UI: 26 historical pulls, no duplicates. Two new wells had empty live projections; after verifying the completed governed import and empty heads, derived projections were initialized separately with reconciliation audit evidence. The import callable's model-seed cold-cache issue was not fixed by this change.

Both wells opt into the existing inventory-balance estimator. New packet ingestion continues to refresh projections automatically. Historical source times, top readings, written barrel quantities and packet identities were preserved.

Granli's subsequently supplied manufacturer plaque replaces its provisional tank dimensions: two equalizing tanks, 500 BBL nominal each, 20 ft height, 13 ft 6 in diameter. Following the existing diameter-based calibration convention, 25.5 BBL/ft per tank gives a 51 BBL/ft bank. Historical computed after-levels were recalibrated with original import provenance retained and an appended correction audit; actual reported readings and live packet provenance were preserved. The owner subsequently relayed that Dwyer's tanks look the same; its four-tank configuration now uses those dimensions, explicitly marked as a driver visual comparison rather than a verified Dwyer plaque. Do not copy Granli's serial/year to Dwyer.

## Imported history visibility repair

On-device verification found that imported packets lacked top-level `companyId`; the governed company appeared only in nested import provenance. The exact-well Mobile reader correctly excludes records lacking its required tenant field. Do not relax that reader or infer arbitrary packet ownership during reads.

Product checkpoint `d0ab5453` adds the authoritative import company to newly built historical packets. Functions build and both focused import suites passed (17 tests). Only `applyHistoricalPullImport` was deployed; its active deployed packet builder byte-matches the compiled checkpoint. Existing affected rows from the completed governed import received the missing company projection after checking the batch, well tenant and nested provenance. No new load identities or source measurements were created. Independent inventory-balance arithmetic agrees with both published AFRs. The original model-seed cold-cache limitation remains separate.

After the owner released the ZFold, both exact-well histories were reopened and their complete counts/totals verified on screen. Dwyer's tank card and info modal show the corrected dimensions, tank count, per-tank calibration, operator and edit permission; its main-card AFR matches the server projection. Granli's corrected main-card AFR and tank details were also verified. Evidence remains in private device captures outside Git. Watchdog was Connected/Ready, actively checking, with the confirmed live receipt complete and no reviews pending. No synthetic loads were added for this acceptance check.

## Immediate tank-edit recalculation

Product checkpoint `e1addbc5` adds a derived refresh to `saveWbmTankInfo` for flow-relevant edits. The callable awaits completion and records `recalculatedAt` on the audited operation receipt. An acknowledged retry does not apply the edit twice, and an unfinished receipt can resume recalculation. Competing observation/configuration changes trigger a fresh bounded retry. Notes/H2S edits avoid the flow path. The three existing estimator modes remain selected by each well's configuration; unusable corrected data clears a stale rate.

Only `saveWbmTankInfo` was deployed. The active handler and both recalculation helpers byte-match the compiled product checkpoint. Build and 98 focused tests passed, including old refresh/ON/inventory behavior, calibration refreshes for all estimator modes, source preservation, conflicts and retries. ZFold M107 passed an actual authorized calibration edit and restoration: the main-card AFR changed both ways without a new observation, restart or manual refresh. Exact private results and immutable-field comparisons are outside Git.

A separate Mobile draft correction on branch `codex/wbm-stale-level-20261005`, product checkpoint `297c784`, keeps the single visible count aligned with the active count when all known tanks are in use. An explicitly smaller active bank remains protected. M108 build `6cbf72a4-a0b1-47c1-9a3a-37dcc0cdbffe` was installed and version-verified on ZFold. The visible count reduction and restoration both updated the counts, badge and AFR without another observation or app restart. Final settings/rate and all source observations were verified restored/preserved. No production pull-processor or security-rule deployment was required for this work.

Customer/payment identity remains separate from legal well operator. The Tallgrass customer and both well choices were verified in the live Dispatch builder without creating jobs. Requested route assignments were appended while retaining existing routes and viewer restrictions.

Private exports, photos, device captures, credentials, backups and reconciliation records remain outside Git. The HP migration is pending until the home machine is reachable.
