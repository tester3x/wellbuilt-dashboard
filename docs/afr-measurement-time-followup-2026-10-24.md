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
