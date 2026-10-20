# Combined-post time estimation — 2026-10-19

Local Watchdog source branch codex/watchdog-combined-time-20261019, based on HP's verified stockyard source and later documentation checkpoints. Backend source is separate codex/watchdog-rejection-isolation-20261018 to preserve the live processor's reported-bottom/provisional-volume fixes.

Combined reports for distinct known wells with only the multi-well timing issue can use recent completed single-row reports from the exact same sender/channel. Use mean of last20 consecutive usable intervals (15–240 minutes), minimum3 samples. No calendar-date boundary; overnight/rest-sized gaps are excluded by duration. The last load uses the post time; earlier rows step backward by rounded mean. Refuse overlap with last known load, insufficient history, unknown wells, edits/deletions, or other unresolved issues. Human exclusions and existing deliveries remain intact.

Earlier rows carry timeEstimate metadata with method, sample count, interval and anchor. Local transport forwards that metadata; backend validates it and marks such observations provisional for AFR even when barrels are later confirmed. Raw original post/levels remain unchanged. Barrels continue through existing provisional calibrated estimate/capacity logic.

Pure estimator tests passed (sender isolation, unknown names, averaging, midnight). Source checked against private current post/history:108 minutes,20 samples. No raw posts or customer records committed. Runtime installation and intake receipt verification pending.
