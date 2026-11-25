# Fixed photo fallback redeployment — November 24, 2026

Mike confirmed the earlier deletion was intentional and explicitly authorized
redeployment of only the repaired photo fallback, delivery-off testing, then
new-photo activation if it passed. No historical resends were authorized.

## Source and scope

- Registered home: `C:/dev/dashboard-current-20261004`.
- Branch: `release/dashboard-pw-exception-scoped-20261119`.
- Deployed source: `b1be346632a6e0ed59c05b0e955cdb264495b47a`, exact clean,
  pushed HEAD after fresh origin reconciliation.
- Compared the last verified Nov. 22 live archive: 30 transitive modules,
  only `photoFallback.js` and `photoFallbackCore.js` changed as intended.
- TypeScript compilation passed. All 23 Watchdog suites / 179 tests passed
  from the Functions working directory. An earlier root-directory test run
  failed before running tests because its relative test configuration resolved
  incorrectly; that invocation is not claimed as a pass.
- Deployed only `functions:dashboard:processWatchdogPhotoFallback` to
  `wellbuilt-sync`. No other Functions, Hosting, rules, indexes or apps deployed.
- ACTIVE revision: `processwatchdogphotofallback-00001-vet`, updated
  `2026-11-25T00:33:59.024417628Z` (Nov. 24 Central).
- Firebase source hash: `70841ea09de52c87160cb5a4e5a10ed93a13f578`.
- Downloaded the new deployed source archive: all 30 transitive compiled modules
  byte-match the prepared build after line-ending normalization.

## Delivery-off canary

Before deployment, fallback stayed disabled and delivery was explicitly set
false. A fresh activation cutoff excluded existing photos. After deployment,
fallback was armed with delivery still false and one clearly marked synthetic
photo was created under a unique test message/image identity. A private copy of
a previously verified gauge image was re-encoded with a test marker; the real
photo, message and receipts were not changed or resubmitted.

The synthetic source included stale `bottomFeet` and `delivery.packetId` audit
fields to reproduce the failure. Two actual model reads agreed. The function
returned `review / cloud_read_awaits_activation`, replaced the audit map and
removed the stale delivery field. A timestamp-only worker update did not change
the audit or cause another model read. Four readbacks over more than two minutes
showed one stable audit timestamp and exactly two stored model reads. Monitoring
showed only small single-digit request counts per minute, not the old sustained
1,200+ requests/minute.

Queries confirmed no synthetic intake delivery or message reservation. The
synthetic source was marked edited, then removed with an update-time
precondition; only its exact private Storage object was removed. The synthetic
inference job/cache/budget evidence remains preserved. No real photo, hold,
load, receipt or worker queue was deleted or resent.

The private activation helper initially tried to read the already-cleaned test
document and stopped with 404 before any activation mutation. Its activation
path was corrected to verify the cleanup receipt instead. Final activation
then succeeded and was read back independently.

## New-photo activation

Readback verified `enabled=true`, `allowDelivery=true`, with
`enabledAfterMs=1795567093238` (`2026-11-25T00:38:13.238Z`, Nov. 24 **6:38 PM
Central**). Only newly posted photos after this cutoff may qualify. Existing
historical inbox entries are not requeued or backfilled. Message/image claims,
daily budget, sender/well/barrel restrictions and duplicate barriers remain.

Recursive comparison against the pre-canary policy showed only the intended
enabled flag and activation-cutoff changes; delivery returned to its prior true
setting and all other policy fields were preserved. Private deployment logs,
policy snapshots, byte comparisons, canary evidence and monitoring captures are
under `C:/dev/release-artifacts/watchdog-rog/`, outside Git.

The separate signed-JSA/receipt-authentication audit remains undeployed.
