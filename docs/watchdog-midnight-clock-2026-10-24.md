# Bare noon and midnight clocks

The shared parser inferred AM/PM only for bare hours below twelve. Consequently a
bare twelve o'clock report posted just after midnight became noon, was correctly
held as a future observation, and never reached the live well projection.

Inference now covers bare hours one through twelve, including compact clocks in
supported clock positions. Zero-hour 24-hour clocks are unambiguous. The existing
two-hour proximity guard and distant-time review remain; an explicit AM/PM suffix
is never reversed. No gauge, volume, tank calibration or fallback policy changes.

All 33 parser checks and all 82 worker checks pass, including midnight, noon,
24-hour zero, compact clocks, explicit meridiems and distant-time holds. The live
held observation was released through the existing signed review workflow with
its original gauges and quantity, preserving its original message and audit.
Canonical readback and the actual ZFold display confirm the corrected AM time.
Customer evidence and before/after records remain private outside Git.

Permanent scoped intake deployment and HP parser installation pending.
