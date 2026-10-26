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
Source `008428df` is deployed to `processIncomingPull` version 105,
`processDeleteRequest` version 91, `processEditRequest` version 96 and
`reconcilePendingEditOutbox` revision `00013-qod`. Only the ON module source,
compiled module and map changed in each fresh live source capture. Downloaded
archives byte-match; settings, triggers and IAM are preserved.

Restored all 43 values withdrawn by the incorrect date restriction and corrected
two additional absent values. The ON-only backfill preserves original history,
well status, AFR and configuration, including a well with a rolling AFR model.
After a fresh 75-production-well audit there are 59 valid matching ON projections
and no calculation mismatches among projections with matching canonical identity.
Independent arithmetic checks also match. One old identity/date inconsistency
remains outside this recalculation; no original timestamps were invented or
altered to resolve it. Continuous-hauling AFR and inferred-time ON readbacks are
unchanged. Private backups and per-well evidence remain outside Git.

No new Mobile APK is required; a normal revision notification refreshes build 101.
