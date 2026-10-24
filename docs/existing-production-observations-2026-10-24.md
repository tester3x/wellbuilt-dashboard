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
is required. Exact live replay, scoped deployment and projection refresh pending.
