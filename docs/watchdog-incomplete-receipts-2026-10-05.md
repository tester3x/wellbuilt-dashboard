# Watchdog incomplete receipts — 2026-10-05

Authoritative laptop branch: release/dashboard-reassignment-20261005.

Unmapped senders omit driverName in RTDB (null is removed). The processor previously put that undefined value in wells/status/lastPull, causing Firebase to reject the status write after history, outgoing, performance and AFR were committed. Mapped senders were unaffected. Status now omits an absent name; no guessed ownership is assigned.

Completion now records canonicalProcessingBottomInches. Watchdog receipts validate that committed bottom plus matching observation provenance and existing material fields. Legacy receipts retain their original bottom validation. This resolves calibrated Gunslinger intake versus canonical tank-count math without changing measurements or rates.

Three confirmed partial writes were repaired with conditional ETag writes: two Kahuna 5 and one Gunslinger 3. No packets were resubmitted, deleted or added. Latest outgoing/history identity was checked before rebuilding latest status; older Kahuna history was preserved. Missing production counts were restored with a per-packet completionRepairs journal. Completion markers were written after status/production, and incoming_version was advanced. Private snapshots and repair scripts remain excluded from Git.

Validation: TypeScript build passed; 14 intake/receipt tests passed, including rejection of a changed canonical bottom or wrong observation. Expanded notification suite had one pre-existing source-census assertion failure (expects three call sites; branch has two); no notification source was changed.

Deployment: processIncomingPull missing-name fix deployed successfully. Final processIncomingPull + getWatchdogPullReceiptV2 deployment completed successfully from e6c3e62e. Live watchdog is Connected / Ready and all three repaired deliveries report complete. Re-read verification confirms no new affected packet IDs and unchanged original time, top, bottom, barrels, ownership and flowRateDays. Latest unified status identifies the latest existing packet for each well.
