# Automatic ON across rate models

The shared calculation selects the last observation on the prior observed Central
calendar date and the first on the next observed date, including afternoon first
pulls and gaps with days without pulls. There is no morning cutoff or fixed
overnight clock range. Later same-day pulls do not move that first endpoint.
The initially imposed consecutive-date condition was corrected; see
`multi-day-on-production-2026-10-24.md` for the normalization and restoration.

ON is now independent of AFR model selection. Ordinary, rolling-flow and
inventory-balance wells recalculate ON after normal intake, late arrivals,
corrections and deletions. Ordinary-well refresh changes only ON metadata, not
AFR, original measurements or tank calibration. A concurrent newer projection
is never overwritten. Explicit `overnightProductionMode: 'afr'` still suppresses
ON, and trusted inferred endpoint clocks retain the `ON ≈` marker.

For continuous hauling a date-crossing interval is mathematically possible, but
it is often short and more sensitive to gauge/time error than an idle overnight
gap. Keep a per-well AFR-only policy for those operations; do not automatically
classify wells by production rate or route. Existing policies are unchanged.

Validation: 48 backend checks pass, including 2 PM first pulls in all three rate
models, later pulls, late earlier records, edited/deleted first endpoints,
continuous-haul suppression, DST and estimated clocks. Four exact live-source
trees compile. Source `733520c7` is deployed to `processIncomingPull` version 104,
`processDeleteRequest` version 90, `processEditRequest` version 95 and
`reconcilePendingEditOutbox` revision `00012-lit`. Runtime settings, triggers and
IAM are preserved. Downloaded source archives byte-match the scoped overlays.
Final readback retains the estimated-clock ON value and the continuous-hauling
AFR-only exception. Watchdog remains Connected/Ready on all nine watched groups.
No new Mobile build is required; build 101 already consumes the metadata.
