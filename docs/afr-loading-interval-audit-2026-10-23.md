# AFR loading-interval follow-up

Read-only investigation; no AFR replacement deployed and no historical loads or
rates rewritten during this follow-up.

The overnight selection/cache repairs do not validate the AFR used for fallback.
A steady-inventory counterexample shows an independent defect: measured bottom
to next top can represent less water than the verified withdrawal, while the
calculation divides by the full interval between load records. Production during
loading is then absent from the numerator. A recorded measured bottom should not
be replaced or described as invalid to correct that timing mismatch.

A conservation check must compare levels at the same measurement phase and add
all distinct verified withdrawals in that exact interval. It must account for
storage rising or falling, both haulers' loads, overlapping loading, provisional
amounts/times, late events, edits, deduplication, and gaps in observation capture.
Hauled barrels alone are not automatically the production total. No assumed
loading duration or forced match to a target rate is justified.

Five independent read-only physical assertions reproduce the reported low-rate
counterexample and verify steady, rising and falling storage plus multiple loads.
Recent live-source inspection confirms AFR still uses persisted recovery-rate
samples with anomaly filtering and EMA; it is not a withdrawal/inventory balance.
Raw production and message evidence stays outside Git.

A separate source-to-receipt audit verified that close-together loads from two
drivers remained distinct and reached processed history. A morning observation
is present in WhatsApp but absent from the receiver queue and processed history;
an identical same-sender repeat seconds later requires duplicate confirmation
before reconciliation. Historical WhatsApp inspection was read-only. Receiver
health remains connected. Neither a healthy heartbeat nor matching ON/AFR proves
that capture is complete or that the underlying AFR is physically correct.

Remaining: confirm the repeated post, recover the missing real observation via
the governed historical path, diagnose why catch-up missed it, and implement and
replay a consistent measurement-phase production estimator before live rollout.
