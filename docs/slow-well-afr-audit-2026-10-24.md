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
