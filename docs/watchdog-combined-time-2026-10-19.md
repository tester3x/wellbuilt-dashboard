# Combined-post time estimation — 2026-10-19

Local Watchdog source branch codex/watchdog-combined-time-20261019, based on HP's verified stockyard source and later documentation checkpoints. Backend source is separate codex/watchdog-rejection-isolation-20261018 to preserve the live processor's reported-bottom/provisional-volume fixes.

Combined reports for distinct known wells with only the multi-well timing issue can use recent completed single-row reports from the exact same sender/channel. Use mean of last20 consecutive usable intervals (15–240 minutes), minimum3 samples. No calendar-date boundary; overnight/rest-sized gaps are excluded by duration. The last load uses the post time; earlier rows step backward by rounded mean. Refuse overlap with last known load, insufficient history, unknown wells, edits/deletions, or other unresolved issues. Human exclusions and existing deliveries remain intact.

Earlier rows carry timeEstimate metadata with method, sample count, interval and anchor. Local transport forwards that metadata; backend validates it and marks such observations provisional for AFR even when barrels are later confirmed. Raw original post/levels remain unchanged. Barrels continue through existing provisional calibrated estimate/capacity logic.

Pure estimator tests passed (sender isolation, unknown names, averaging, midnight). Source checked against private current post/history:108 minutes,20 samples. No raw posts or customer records committed. Runtime installation and intake receipt verification pending.

Installed HP runtime b53a69c6 via preserved source branch; existing scheduled task restarted with saved WhatsApp session. The only manually reopened decision was the mistaken Gunslinger5 exclusion, with the former decision retained in queue.reviewDecisionHistory and a full pre-change queue backup. Receiver recovered Connected/unpaused with advancing checks.

Backend fb28e9e6 deployed only ingestWatchdogPullV2, processIncomingPull, processEditRequest, processDeleteRequest, reconcilePendingEditOutbox and watchdogStrandedPackets. Existing processor parity source retained. Functions build plus17 focused tests passed; pre-existing unrelated intake fixture failures were not rewritten.

Live verification: original combined report and a newly arrived same-sender combined report each produced exactly two completed packet receipts. Earlier timestamps carry estimated/back_to_back_average metadata with20 samples and108-minute interval; later timestamps use post time. All four reported bottoms preserved, barrels165 marked provisional, canonical completion true and flowRateDays zero. Private before/after/packet-ID receipts retained outside Git. No duplicate loads recreated. User-confirmed Wilson33/Matilda WhatsApp duplicates excluded with exact existing-app packet references; original app records unchanged. Local/cloud review queues both empty after sync.
