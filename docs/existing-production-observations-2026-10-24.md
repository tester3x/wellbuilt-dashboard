# Reuse confirmed observations for production

Two completed-load endpoints establish a conservation balance. The former
three-reading/six-hour gate unnecessarily retained old AFR when two reliable
endpoints already spanned several hours. Inventory mode now accepts two endpoints
over three to twenty-four hours; the shorter floor continues to reject brief,
overlapping gauge noise. Longer available windows still use the full interval.

An interior load's exact time does not affect total withdrawals between endpoints.
Confirmed quantity with trusted, bounded back-to-back timing can therefore be
included when its entire declared admissible interval lies inside exact endpoint
times. Estimated points cannot be endpoints. Malformed or out-of-span timing,
unconfirmed quantities, down/barrier readings, conflicts and invalid measurements
remain excluded. Original time-estimate provenance is never converted to fact.
The result reports the count of estimated interior observations.

Forty-one focused estimator, actual-entry-point, refresh and overnight tests pass,
including intermediate-time invariance, estimated endpoints, timing bounds,
unconfirmed amounts, two-point balance and delete/rebuild behavior. No app build
is required.

## Live verification

Checkpoint 7658c8d1 compiles against exact downloaded live source. Actual deployed
AFR entry-point replays use existing canonical observations and match conservation;
previously corrected reference wells remain unchanged. Scoped source overlays
change only the estimator's source, compiled module and map in the incoming,
delete, edit and edit-outbox handlers. Full deployed archives match their overlays
byte-for-byte, with runtime, trigger and IAM preserved.

The two affected current projections were refreshed using the same deployed
helper. Readback verifies corrected AFR and independent ON. Entire original
histories, gauges, timestamps, ownership and down state are unchanged. All tank
configuration fields are identical; only derived rate/forecast fields change.
Private immutable before-images, completion evidence and exact customer values
remain outside Git.

During the final receiver health check, a new/exhausted group's undefined native
history response exposed a coverage-check incompatibility. The receiver now
accepts that response only after a fresh request and explicit no-earlier-history,
loaded-context, no-loading and no-repair flags. Missing/ambiguous responses still
fail closed and preserve checkpoints. Six additional cases pass; all 82 worker
checks pass. HP source was fast-forwarded after verifying tracked files were clean;
its 14 focused recovery checks pass. The existing supervisor restarted the worker
with its saved session. Live readback is Connected/Ready, unpaused, error-free,
with fresh matching checkpoints for all nine watched groups and no pending
deliveries. The sole review is a new uncalibrated pad observation, retained intact.
No WhatsApp message or QR relink was required for this recovery.
