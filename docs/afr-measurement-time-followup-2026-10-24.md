# AFR measurement-time clarification — audit checkpoint

The operator clarified that pull/post timestamps are generally near completion;
loading-start times are not reliably available. A separate level timestamp is not
always supplied. Do not infer a measured loading duration from these records.

The previously deployed precision repair retains fractional inches in an existing
baseline. It does not make that baseline an observed completion level or establish
that its timestamp corresponds to the top reading. Prior validation establishes
arithmetic and delivery correctness within the existing model, not exact physical
production for observations whose measurement phases are unknown.

For a top-minus-withdrawal baseline, adding production since the top-reading time
requires that time to be known. A reported completion level already contains
production during loading. A completion-to-completion conservation calculation can
include that production without assuming load duration, provided endpoints,
withdrawals and observation capture are trustworthy. Never mix a calculated
top-minus-withdrawal baseline with a measured completion level as if interchangeable.

The wider well audit is read-only. Its private evidence distinguishes confirmed
rounded arithmetic, measured versus calculated baselines, demo records and older
AFRs that do not replay under the present model. No additional live data changes,
APK builds or deployments have been made. Bulk reconciliation remains unfinished
pending a safe treatment of measurement-time uncertainty. Preserve original levels,
quantities, timestamps, tank calibration and per-well model choices.

## Scope resolved and rounding audit completed

The operator reaffirmed the existing WB M model: deduct the entire withdrawal
and continuously project production. Fractional entered top levels are already
floored to whole inches with an equivalent timestamp backdate. Preserve that
normalization. Fractional inches created later by the quantity/bank deduction
are a separate arithmetic issue; retaining them must not restore the raw entered
top fraction or backdate a timestamp again.

The precision-only audit covered all 94 configured entries, including 85 non-demo
entries and 76 non-demo entries with measured history. Guarded writes corrected
508 historical derived intervals across 24 production wells. Thirteen current
projections were replayed where their existing averaging baseline was proven;
others were preserved. Post-write audit finds zero remaining confirmed instances
of this rounding signature in non-demo history, and all rebuilt projections
match read-back. Raw tops, timestamps, quantities, tank settings and ON values
remain unchanged. No new production source or APK deployment was needed; the
global precision fix remains live at processIncomingPull version 106.

Two pre-existing legacy projections do not reproduce under the present averaging
method. Their published rates were preserved; historical precision corrections
are not authorization to replace an unexplained model discrepancy. Details and
before/after evidence remain private. They require a separate model audit.

The reconciliation batch completed before an attempted stop following the top-time
normalization clarification. Every write was subsequently checked against the
saved original: processed changes are limited to recovery and interval-rate fields,
with no top or timestamp normalization changes. Regression tests explicitly prove
both the operator's one-inch-per-fifteen-minutes example and preservation of the
whole-inch top/backdated-time equivalence after full-volume subtraction.

Current validation: 74 backend model/projection/ON checks and 27 Mobile projection,
automatic-delivery and recovery checks pass. Mobile test checkpoints 0f9a45e and
bdf6508 are committed and pushed; runtime remains installed build 101. The physical
UI follow-up could not acquire an idle UI snapshot and performed no navigation;
server read-back and transport regression acceptance are complete.

The operator emphasized that surging production and approximate field observations
make half-inch precision a minor concern. Do not present these small numeric changes
as newly established physical production or introduce extra driver requirements.
Prioritize complete observations, correct quantities, continuous projection and
automatic delivery. No smoothing method was changed.
