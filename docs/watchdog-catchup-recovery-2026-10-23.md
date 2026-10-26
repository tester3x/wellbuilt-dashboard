# Watchdog catch-up and dashboard recovery — 2026-10-23

The real reboot resumed automatically at Windows sign-in using the saved link.
The receiver caught two overnight reports. It submitted the later report first,
which caused the processor to hold the earlier one as STALE_PULL_TIME.

Delivery now sorts individual observations by measurement time and blocks a
well's later observations until an earlier queued/incomplete observation has a
server completion receipt. Other wells continue. Intake errors preserve the
original queue and cannot promote a later sibling. No pending entry is deleted
on reconnect or submission alone.

The dashboard gets a direct, company-authorized server resolution for owned
processor rejections. A confirmed stale observation can be recorded as historical
using its original identity, packet ID, measurements and timestamp. The operation
validates policy, revision, actual rejection ownership, calibration, duplicate
history and a newer recorded observation. It cannot replace current/lastPull,
configuration, outgoing views or invoices. Exclusion is a separate audited office
decision; the original rejection remains. A failed write releases its claim and
can be retried; packet insertion and the resolution are idempotent. Historical
completion has its own verified receipt and does not fabricate canonical live
processor completion. The HP consumes that server receipt when online, while the
dashboard can resolve the record without waiting for the HP.

Validation: 35 worker tests, 11 recovery/authorization tests, and Functions build
pass. The full intake suite has six unchanged baseline failures caused by older
measurement fixtures: both HEAD and patched source fail the same six test names;
20 other intake tests pass in both. No production parser changes were made here.
Frontend browser verification covers reason gating, direct recovery/exclusion,
server failure/retry, company scope and preserved manual refresh. Release and
operational repair evidence follows after deployment.

## Deployed, installed and operationally verified

The historical load was recovered with resolveRejectedReview, the same server
logic used by the dashboard callable, through authenticated Firebase CLI operator
credentials. The exact original observation, timestamp, identity, packet ID and
185-BBL amount were validated first. The original rejection and audit were kept.
The current well status was byte-identical before/after; repeating the operation
returned the same completed historical receipt without inserting another load.
The signed live receipt endpoint independently confirmed historical completion.

Functions resolveWatchdogRejectedReview and getWatchdogPullReceiptV2 deployed from
74998269. The first syncWatchdogReviewV2 update expired in Google's build queue;
its scoped retry from d4c1ec95 succeeded, with service revision
syncwatchdogreviewv2-00003-ros active at 2026-10-23T13:26:07.578791244Z.
A real signed replay of the old review snapshot returned the completed receipt,
no pending command, and could not reopen the resolved hold. Signed-out access to
the new callable returned HTTP 401 / Sign in required.

Worker source d4c1ec95 is installed on the HP. All 35 worker checks also passed
there. A missed already-synced SDK event is now bootstrapped only after verified
CONNECTED state and hasSynced; unpaired sessions cannot use it. Raw receiving can
also begin from Connecting only when the page proves authenticated and all
configured groups are synced. A browser-cleanup exit race is nonfatal to restart
supervision. Owned rejected receipts are periodically rechecked, so a dashboard
resolution can clear the HP hold only after the matching server receipt.

At 2026-10-23T13:26:29.885Z the HP reported Connected, unpaused, a fresh receiver
check at 13:26:26.936Z, transport Ready, 495 complete receipts, no pending or review
items, and all eight configured groups covered. The queue and linked profile were
preserved. No simulated production load was used.

Hosting source 638715a62734ff6388a4e4678f7ed8593db06cd7 is live; all 362 exported
files were byte-verified at 13:14:52.162Z before the shared release checkpoint
advanced. Existing dashboard behavior and manual-only refresh passed mandatory
preflight checks. Frontend release notes are in the Dashboard release lane. No
phone APK or database/Firestore/Storage rules deployment was performed.
