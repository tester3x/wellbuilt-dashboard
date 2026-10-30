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

## Olson addition

Owner requested the same Tallgrass payer / Liquid Gold hauling setup for a third operational pad, Olson, with two provisional equalizing tanks matching Granli/Dwyer dimensions. The active NDIC 34X-19D record links the nearby Arnegard Olson pad; all five same-pad NDIC wellheads are retained as metadata. Channel context explicitly places Olson next to Granli. Config was created through the governed Add Well UI, then enriched with tenant/operator, coordinates, nominal capacity, active bank and provisional calibration provenance. No Granli plaque serial/year/manufacturer verification was copied.

Latest owner-directed provisional tank configuration: FOUR active 500-BBL nominal tanks, 20 ft tall, 13.5 ft diameter, 25.5 BBL/ft per tank and 102 BBL/ft bank, explicitly awaiting Olson field verification. Owner changed the initial two-tank assumption to four because the driver had already left before receiving the inspection request. All visible/active/total count fields and calibration provenance were updated together; the derived flow refresh ran without creating observations or an initial rate. Inventory-balance production mode is enabled; no rate, observation or history was fabricated or seeded. Existing four Tallgrass route accounts remain assigned, including LGDispatch's viewer restriction. Tallgrass Dispatch selection and Watchdog lifecycle both visibly include Olson. Group activation time and existing channel settings were preserved.

After scope refresh, an actual new written-140-BBL Olson post was recognized but held because it has no level; it has not produced a processed load or AFR. Two dispatch ticket-number messages were dismissed from review with source records preserved. Receiver remained Connected/Ready/Watching. Public NDIC lookup, private before/after backups, mutation audit, Dispatch screenshot and final verification are outside Git. No APK or backend deployment is needed for this catalogue change. Phones were disconnected during this final addition check, so do not claim on-phone Olson acceptance.

After the owner reconnected both devices, S24 M110 visibly showed Olson on Tallgrass with its legal operator, four-tank badge, unavailable level and no flow data. The settled info card showed 20 ft height, 13.5 ft diameter, 500 BBL nominal capacity, 25.5 BBL/ft per tank and the provisional notes. No load or tank edit was submitted during this check. Owner confirmed the first load lacks levels and instructed that Olson stay active while continuous hauling is still being decided; retain the held source without inventing a level or AFR.


## Completed HP handoff — October 26 evening

The home HP was reachable through its existing key-based LAN SSH access. Fetched before comparison; its tracked source was clean at dd8b182a959ea4aaf6eeb5aeb6308b93d242b8b4, with unrelated untracked helpers preserved. Fast-forwarded to 753bb533458e28f517a55233ac45682ca291c96f, which includes the newer historical-recovery checkpoints and Tallgrass parser. Functions TypeScript build passed on HP; compiled pullParser.js SHA-256 matches the laptop (20E5DB962CDEA691570AF0563356E6BECBF6D6B76E0391AF8B53AD01B846E87F). All 66 worker tests pass on HP. No cloud deployment was performed.

Laptop delivery was paused with zero queued/incomplete receipts, then its WhatsApp connection was stopped and the durable queue snapshotted. HP was paused/stopped through its normal API; its supervisor and exact verified worker were stopped before any offline queue write. Backups and an invariant-checked migration audit remain in HP's private Watchdog data directory. Only Tallgrass messages, their original message/row identities and receipts, its checkpoint and its channel configuration were appended. Existing HP message/receipt data, nine other channels, options, checkpoints, signing material and its own linked WhatsApp session were preserved. Browser profiles and signing keys were not copied.

Thirty Tallgrass messages and six existing delivery/review decisions were transferred. Five older rows without receipts were explicitly marked before_activation using the laptop's original cutoff; these measurements had already been imported through the governed history workflow. The HP's earlier global cutoff was not substituted for that source cutoff. This prevents the handoff from replaying imported history as fresh pulls.

HP restarted through its existing scheduled task, restored Connected/unpaused/Ready, and completed a Tallgrass history check past the source checkpoint. Every source message body/time/identity and receipt survived; no source messages were missing or receipt decisions changed. Signed receipt reads confirm the same three completed canonical packet identities. Granli, Dwyer and Olson all report watching. Tallgrass has zero queued/incomplete deliveries; its sole review remains Olson's missing-level post.

An independent before/after canonical comparison found the exact histories unchanged: Granli 11, Dwyer 18, Olson 0; all three AFR values also unchanged. No extra pull was created during migration. The laptop retains its recovery copy with connect/watching disabled; HP is now the active Tallgrass receiver, alongside its existing groups. Private migration files, queues, receipts and credentials remain outside Git.

## Automatic startup verification — October 26 evening

The HP's enabled WellBuilt Watchdog task uses the existing miknd Interactive principal and Windows logon trigger. It has StartWhenAvailable enabled, unlimited execution time, a one-minute restart interval and 999 retries; the installed startup script byte-matches the source. Windows automatic sign-in is not configured. This means a full reboot requires the normal Windows account sign-in before this task can start; unattended pre-sign-in execution is not claimed or enabled.

An actual worker termination through the fixed-port recovery script was tested with the laptop receiver stopped. The supervisor replaced the old worker, and its saved reconnect/watch intent automatically restored Connected, Ready and unpaused. Tallgrass completed a fresh check and the original messages, three canonical completed receipts and held Olson review were unchanged. No manual Connect/Resume action was used for this recovery.

A full HP reboot was then initiated without force-closing applications. The verified boot timestamp advanced from October 23 to October 27 01:09 UTC. SSH became available again, while the Watchdog task remained Ready with no receiver listener and its prior last-run time, consistent with the required Windows sign-in not yet occurring. Owner was asked to sign into the existing HP account. Post-sign-in automatic start/catch-up remains pending; do not report that full reboot acceptance passed yet. No credentials, logon protections, task principal or triggers were changed.

## Full reboot acceptance completed

After the owner signed into Windows, the existing scheduled task ran automatically (01:22:30 UTC) and launched a new worker without a manual Connect/Resume request. The fresh receiver reached Connected/unpaused/Ready and checked Tallgrass after startup (01:26:09 UTC). Its ten configured groups, all 30 Tallgrass source messages and completed/review state survived. The laptop receiver was independently confirmed Stopped/paused with connect=false and watching=false throughout. This completes reboot-after-sign-in acceptance; startup before Windows sign-in remains outside the configured task's capabilities.
