# Adaptive local Watchdog monitoring - 2026-11-24

Mike requested learning quiet periods rather than hard-coding Gunslinger to
6PM-6AM, and temporarily pausing Gabriel automation while he supplies those
levels through WB Mobile/Tickets. This is monitoring only, not a well-down state.
Gabriel shares a channel with Thor; Thor must remain active.

AdaptiveMonitoring learns from locally captured, non-deleted, non-export posts
in the selected channels over30 days. It derives a median within-shift posting
interval and observed local clock hours; three observed days are needed for an
empty hour to count as a pattern. Quiet also follows a sufficiently long gap.
There is no fixed Gunslinger schedule and no cloud training read. New work
always takes the fast delivery/policy path regardless of a learned quiet period.
WhatsApp capture remains frequent/local. Existing heartbeat frequency and backup
claim/reservation protections stay unchanged.

When all enabled channels appear quiet, background completed-receipt audit batches
move from ten minutes to one hour and idle lifecycle refresh from five to30
minutes. Unchanged office holds in quiet channels check every15 minutes instead
of five. New revisions, pending receipts and new eligible messages retain their
normal handling. These are bounded cloud-check intervals, not a shutdown of
message capture. Fewer calls are expected only during idle periods.

Manual pausedWells is a separate worker.json setting. Only Gabriel1-7 are paused;
Thor1/5 in the same channel remain enabled. A report first encountered during the
pause is locally marked monitoring_paused, so removing a pause later cannot
replay the skipped reports automatically. Existing deliveries/holds remain.
Cloud Watchdog channel policy is to retain Thor and place Gabriel in explicit
manual monitoring holds. WB M/T submissions, well operating state and history
are not changed. Local configuration and cloud policy receipts remain private.

Validation:120 cases,117 passed, three private-photo fixtures skipped. New cases
cover learned overnight/daytime quiet, immediate unexpected daytime activity,
Gabriel/Thor separation, disabled compatibility, and no replay after a pause.
Runtime rollout and health evidence will follow separately. No historical resend.
