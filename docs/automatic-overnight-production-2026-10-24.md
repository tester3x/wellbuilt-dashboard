# Automatic ON across rate models

The shared calculation selects the last observation on the previous Central
calendar date and the first on the next date, including afternoon first pulls.
There is no morning cutoff or fixed overnight clock range. Later same-day pulls
do not move that first endpoint. Missing dates do not become an overnight span.

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
continuous-haul suppression, DST and estimated clocks. Scoped live-source
compilation/deployment and final readback are pending. No new Mobile build is
required; build 101 already consumes the estimated-clock metadata.
