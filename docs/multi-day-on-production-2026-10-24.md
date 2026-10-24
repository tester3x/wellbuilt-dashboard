# Recovery across days without pulls

The consecutive-calendar-date restriction was an incorrect interpretation for
slow wells. A well may have no pulls for several days. ON now uses the final
reading on the prior observed Central date and the first reading on the next
observed date, however many empty dates lie between. Later pulls on that date
do not replace its first endpoint.

The same elapsed-time formula applies on either side of 24 hours:

`BBL/day = (first top - prior recorded bottom) * bank BBL/foot * 24 / elapsed hours`

For example 300 BBL accumulated over 12, 36 or 72 hours corresponds to 600, 200 or
100 BBL/day. This is the average recovery during that actual gap. No artificial
24-hour boundary, assumed pull, tank change or timestamp is introduced. Existing
down-state, invalid-level and provisional-quantity guards remain, as does the
inferred-clock marker. Continuous-hauling AFR-only policy remains unchanged.

Fifty-eight focused checks pass, including fractional-hour and multi-day spans,
afternoon first pulls, later pulls, corrections, deletions and estimated clocks.
Scoped deployment, restoration from preserved records and final audit pending.
No new Mobile APK is required.
