# Overnight production audit and correction — 2026-10-23

Home-network read checks confirmed the receiver connected, unpaused, fresh and
Ready, with eight channels, no pending/review backlog and no reported error.
HP SSH and the authenticated local receiver status agreed with Firebase health.
No receiver reset, QR relink or customer message was needed.

Read-only audit covered83 outgoing well statuses and historical replay of the
pipeline plus27 recent non-pipeline wells across six other routes. The exact
live processIncomingPull source was downloaded through the Gen1 download API;
its formula reproduced the live estimates. Raw customer evidence stays outside
Git. An older Dashboard lane's processing index differs from live and must not
be promoted during this fix.

Confirmed issues:
- UTC date comparison changes the overnight boundary during the Central evening.
- Recovery reconstructs a previous bottom from barrels instead of consuming the
  bottom persisted with the prior reading. This can inflate measured recovery.
- Mobile preserves old window/ON estimates when the server withdraws them,
  because RTDB omits null properties and the cache treats undefined as preserve.

User-defined interval: last reading of day1 to first reading of day2. Use Central
civil dates and actual elapsed milliseconds, including DST. ON remains an
individual-interval estimate, separate from AFR; no scaling/clamping to AFR.
A factor-of-two mismatch warrants tracing source evidence, not assuming normal
variation. Some older pipeline wells have sparse/inactive history; no historical
measurements or load quantities were rewritten to make derived rates agree.

The backend module prefers a valid persisted numeric/formatted bottom, retains
legacy arithmetic only when no bottom exists, and refuses invalid/down or
provisional boundaries. It ignores future readings. The history loader and
current reading carry the bottom into the calculation. Both new-pull and delete
rebuild delegate to the same helper. Continuous hauling can explicitly set
well_config/<well>/overnightProductionMode=afr; the producer then withdraws ON,
so Mobile uses AFR without falsely labeling it a measured overnight estimate.
This is an explicit per-well setting, not a guessed activity threshold.

Validation:14 focused backend cases pass, including the actual history loader,
recorded-bottom disagreement, midnight/evening, summer/winter/DST, future data,
invalid/down/provisional evidence and continuous-hauling mode. Functions build
passes. Exact downloaded live source plus this patch also compiles independently.
Its emitted index matches the expected narrow textual changes; no other runtime
changes are introduced by compilation.

Deployment candidate uses separate exact-live source archives for
processIncomingPull and processDeleteRequest. Only source index/helper and their
compiled output/maps differ; every unrelated source/dependency byte is preserved.
Do not deploy the branch's whole Functions index, Hosting or rules. Verify each
function's source bytes, runtime settings, trigger and IAM after deployment, then
recompute only current ON projection with last-pull compare-and-set guards.
Deployment and current projection refresh are not yet claimed in this checkpoint.

Mobile withdrawal fix is separately committed in codex/wbm-stale-level-20261005;
19 focused tests pass. Mobile100 is building from2d6219e. ZFold still has99 until
package/signer verification and S24 smoke checks complete. No device private data
was extracted; observed well selection and ON toggle were restored afterward.

## Live server verification

Exact-source overlays are deployed ACTIVE: processIncomingPull version98 and
processDeleteRequest version84. Every downloaded live source archive byte matches
its prepared overlay. Runtime, trigger, service configuration and IAM compare
unchanged with the pre-deploy snapshots. The two archives were byte-identical in
the affected source/compiled index before the patch; no whole-branch deployment
was performed. Source checkpoint3f5b8f49 identifies the new helper and wrapper.

User confirmed the day1-final/day2-first interpretation and emphasized that
factor-of-two differences must be investigated. Continuous-hauling fallback was
configured explicitly for the user-identified well. A recent owned-company audit
covered33 non-test current statuses; seven ON projections changed through ETag
conditional writes, with fresh last-pull identity checks and calibration guards.
Subsequent read-back proved every non-ON outgoing field unchanged. The continuous
setting was the only configuration field changed. An immutable private before
snapshot and result ledger preserve the correction evidence. A v2 revision token
was published for normal client refresh. No historical readings/loads, AFR,
production-log counts, dispatches, tickets, HOS or shifts were rewritten.

Mobile100 remains in progress. Device cache withdrawal acceptance and the final
installation are still pending; server deployment does not update old binaries.

## Device candidate installed

The focused backend suite now has15 passing cases, including a generic short-gap
regression demonstrating a thousand-BBL/day reconstructed-bottom bias. Product
source3f5b8f49 and the verified live overlays are unchanged by that test addition.
Mobile100 source2d6219e completed, passed package/signer/ARM64/native-bridge
verification and was installed preserving data on both phones. S24 cold startup
retained valid estimates and existing access; actual withdrawal persistence has
19 focused client tests. ZFold post-install screen testing was deferred while
its user was active. No signed inspection, job, shift or HOS test was created.
Final Firebase receiver health remained connected/Ready with eight channels,
zero pending/review backlog and no reported error. Raw evidence stays private.


## ZFold acceptance completed

After the user reopened Mobile and authorized continuing, foreground-guarded,
read-only checks confirmed that a previously cached withdrawn ON estimate now
falls back to AFR without an ON label in either toggle position. A second well
with no supported ON estimate also displays AFR without a stale label. A valid
corrected ON estimate remains available and switches correctly to the daily AFR
view. The explicitly configured continuous-hauling well uses AFR in both views,
without an ON label, and received a fresh real pull during verification.
The original well selection and ON toggle state were restored. No operational
job, level, inspection, shift or HOS record was created or edited by these checks.
Screenshots and exact customer values remain outside Git.
