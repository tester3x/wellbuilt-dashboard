# Watchdog parser and review audit — October 18, 2026

Runtime source branch: `codex/watchdog-stockyard-20261016`.
Parser source checkpoint: `bdea3f3b` (committed on HP; pushed via laptop because
HP Git credential persistence was unavailable). Existing unrelated untracked
HP files were preserved.

Fix: a narrow leading pump-status `On` annotation after a matched well no longer
displaces top/bottom gauge lines. Arbitrary prose remains review-only; a status
annotation alone does not create a load. All 27 parser Jest checks passed on HP
and independently on laptop. HP full Functions compilation was stopped due to
host load; the full Functions build passed on laptop. The tested parser module
was installed on HP and its existing scheduled task restarted the receiver.
Verified connected, unpaused and checking current messages after restart.

Only `dashboard:ingestWatchdogPullV2` deployed from the parser source checkpoint.
Verified ACTIVE revision `ingestwatchdogpullv2-00031-won`, updated
2026-10-18T07:27:45.776170336Z. No Hosting or rules deployment.

The newly held message matched a pre-existing canonical manual WB M load with
identical well, top, bottom and written volume four minutes earlier. Its local
review was excluded with an explicit duplicate reference; the existing WB M
record and total history count were verified unchanged. No second load added.
Local queue backed up before resolution and before runtime restart.

Receipt refresh: eight refreshed, zero errors; stale queued badge cleared.
Remaining delivery statuses: thirteen review records (including one orphan
non-load instruction) and three incomplete estimated-volume confirmations.
Four older reviews have matching manual history and are duplicate candidates.
Eight have conflicting/uncertain time or measurement evidence, including three
identical historical messages awaiting user clarification. The orphan belongs
to a routing/stop-hauling instruction whose parser now yields no load rows.
These older entries were left unchanged pending review; no historical replay,
quantity guesses, well history edits, or outgoing WhatsApp messages performed.

Private evidence and corrected host connection details remain outside Git.
