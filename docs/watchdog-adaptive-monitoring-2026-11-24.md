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

## Runtime and policy verification

- Installed source `b4156bba293c691c57feb9a6e39d9ac812316de8` on ROG then
  HP. Bundle SHA256 `1ffdc84e00f40f9db7a1f4f07f25df2e8d8d9c5221ab227b9abacde3ffd9d52e`.
- All63 manifest files verified on each host;32 selected installed-runtime tests
  passed on each. Parser/dependency lock unchanged. Private runtime/data backups
  retained and original transport bytes/activation cutoffs retained.
- Enabled adaptive monitoring in each private worker.json and paused Gabriel1-7
  only. No channel-wide pause: Thor1/5 remain allowed in the mixed channel.
- Watchdog cloud policy updated using exact document updateTime precondition and
  only channels/heldWells masks. Gabriel1-7 now have manual monitoring holds, no
  automatic resume. Typed equality verified the other eight channel definitions,
  the two original holds and all unrelated top-level policy fields. No well
  config/status, WB M/T data, signed record or historical receipt was edited.
- First HP task restart retained an older listening receiver. Cloud source proof
  caught that before acceptance. Verified its exact Node PID and absence of its
  supervisor, stopped that orphan receiver only, then launched the saved task.
  After normal cold recovery, both cloud reports independently confirmed the new
  source, Connected/captureHealthy, fresh reports and no error.
- ROG local history demonstrated learning: Gunslinger28 posts over six observed
  days, median within-shift gap5,330,000ms (about89min). Several other channels
  were classified quiet from history. This is a bounded activity heuristic, not
  a guaranteed prediction or a fixed nighttime schedule. No cloud training reads.
- Existing delivery maps were unchanged at install verification; natural new
  source posts may continue to arrive and process normally. Monitoring pause
  cannot be lifted by learned activity. No historical resend was performed.
- Latest Dwyer watch still had no new photo event; both worker-health checks
  passed. Next real photo remains pending for exact message-ID/one-receipt proof.

WB T's separate S24-only461 client polling release is recorded in the Tickets
repository. It does not update the Fold or deploy the staged JSA/receipt changes.
