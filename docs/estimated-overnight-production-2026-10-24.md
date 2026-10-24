# Estimated endpoint clocks in overnight production

ON uses the previous Central calendar day's last observation and the next day's
first observation, with actual elapsed time and the recorded prior bottom. There
is no morning cutoff. Missing calendar days do not become an overnight sample.
Continuous-hauling AFR mode continues to suppress a separate ON value.

A bounded, authenticated back-to-back timestamp estimate can now supply an ON
endpoint when its quantity is verified. The outgoing projection carries
`overnightEstimatedTime`; Mobile preserves it with the estimate and displays
`ON ≈`. Other provisional-quantity, down-state and invalid-time protections
remain. Historical timing provenance and tank calibration are unchanged. Window
and AFR calculations retain their existing provisional-clock behavior.

Validation: 42 backend checks and 13 Mobile response/snapshot checks pass. Scoped
live builds preserve unrelated deployment source. Release/device acceptance is
pending. Customer examples, captures and original timestamps remain private.
