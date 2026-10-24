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
