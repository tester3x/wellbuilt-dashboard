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

Validation: 33 worker tests, 10 recovery/authorization tests, and Functions build
pass. The full intake suite has six unchanged baseline failures caused by older
measurement fixtures: both HEAD and patched source fail the same six test names;
20 other intake tests pass in both. No production parser changes were made here.
Frontend browser verification covers reason gating, direct recovery/exclusion,
server failure/retry, company scope and preserved manual refresh. Release and
operational repair evidence follows after deployment.
