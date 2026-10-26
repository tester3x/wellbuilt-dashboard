# Estimated endpoint clocks in overnight production

ON uses the prior observed Central date's last observation and the next observed
date's first observation, with actual elapsed time and the recorded prior bottom. There
is no morning cutoff. Days without pulls are included in the elapsed gap; the
initial consecutive-date restriction was corrected in
`multi-day-on-production-2026-10-24.md`.
Continuous-hauling AFR mode continues to suppress a separate ON value.

A bounded, authenticated back-to-back timestamp estimate can now supply an ON
endpoint when its quantity is verified. The outgoing projection carries
`overnightEstimatedTime`; Mobile preserves it with the estimate and displays
`ON ≈`. Other provisional-quantity, down-state and invalid-time protections
remain. Historical timing provenance and tank calibration are unchanged. Window
and AFR calculations retain their existing provisional-clock behavior.

Validation: 42 backend checks and 13 Mobile response/snapshot checks pass. Scoped
live builds preserve unrelated deployment source. Customer examples, captures
and original timestamps remain private.

Backend source `26aa6f9c` is deployed through source-only overlays:
`processIncomingPull` version 103, `processDeleteRequest` version 89,
`processEditRequest` version 94 and `reconcilePendingEditOutbox` revision
`00011-rub`. Downloaded archives match the scoped overlays; runtime settings,
triggers and IAM are preserved. A derived-only refresh preserves original
history and calibration, and outgoing readback contains the estimated clock flag.

Mobile source `dde5205` produced Android build 101, EAS build
`ef1793d4-c441-4469-bcea-e869bf4ab030`. Package, signer, ARM64 and protected native
storage checks passed before a data-preserving ZFold installation. Physical
acceptance confirms the inferred-time ON marker and continuous-hauling AFR
fallback. Mobile typecheck has the same 20 pre-existing errors as its parent,
with no new diagnostics.
