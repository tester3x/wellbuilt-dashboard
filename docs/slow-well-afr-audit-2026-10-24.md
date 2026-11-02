# Slow-well AFR audit

The ordinary ingestion path read its prior bottom from a whole-inch display
string even though the linked processed measurement retains fractional inches.
This overstates recovery and can inflate interval production. Resolve the linked
measurement before calculating recovery, retaining the legacy projection fallback
only when no valid numeric source bottom exists. The existing provisional-barrel
exclusion, smoothing and tank calibration remain unchanged.

The deployed function has additional protected changes absent from this lane's
index. Release only the scoped precision overlay onto a fresh deployed-source
capture; never deploy this lane's entire index as its replacement.

Validation: seven precision/fallback regressions plus existing effective-flow and
recovery-window suites (16 checks total); compile the exact deployed overlay.
Private read-only audit reproduces each reviewed well's current AFR and identifies
only historical intervals proven to match the old rounded-bottom arithmetic.
Deployment, reconciliation and device acceptance are recorded below when finished.

## Completed release and reconciliation

Precision source checkpoint **79b9b8fa**, committed and pushed. Exact deployed
source was captured, patched and compiled with only the new module and ingestion
integration changed. `processIncomingPull` is ACTIVE at GEN1 version **106**;
downloaded deployed source byte-matches the overlay. Runtime, trigger, settings
and IAM are unchanged. No broad Functions, Hosting or rules deployment occurred.

Seventeen recent derived interval rates, each proven to match the old truncated
bottom arithmetic, were corrected using guarded writes and immediate read-back.
Original levels, barrels, timestamps, tank setup and ON fields were preserved.
Current AFR and next-pull projections were reconciled with the existing smoothing
method. Read-back replay matches every current AFR. The recovery-window well
already used precise measurements and required no data change.

Backend precision, effective flow, recovery windows, projection refresh and ON
regressions: **56 checks pass**. Mobile automatic delivery and recovery checks:
**17 pass**, preserved on its own branch at **e937a18**. These include simulated
new-pull listener delivery, foreground catch-up and revision fallback; they create
no fabricated production work. Installed Mobile 101 displays the live correction
without requiring a new build or manual sync.
