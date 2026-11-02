# Restored ON physical acceptance

On the ZFold, Mobile build 101 displays restored ON values matching live server
readback for four wells spanning roughly two-to-five-day recovery intervals and
three routes. The continuous-hauling AFR-only well retains AFR. Private customer
screenshots and per-well details remain outside Git.

The exact deployed backend refresh module (`008428df`) also generated a synthetic
successive-pull sequence without cloud writes: first pull after a gap, later pull
on that date, first pull on a new date, then another gap. The ON values are
160, 160, 250 and 81. The Mobile lane tests these generated responses through
actual background-sync callbacks, durable snapshots and screen notifications,
including foreground recovery and revision-token fallback. Sixteen focused
Mobile checks pass; the prior 58 backend checks remain the calculation coverage.

No real test loads, shifts, original gauges or tank settings were created or
changed. No new backend deployment or APK was needed for this acceptance run.
This verifies physical restored displays and automated delivery behavior under
mocked transport, rather than claiming a new physical production load occurred.
