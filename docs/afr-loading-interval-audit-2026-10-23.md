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


## Recovery and rollout completed

The owner confirmed that the seconds-apart posts describe one real load. The
first original observation was recovered through resolveRejectedReview using its
original identity and timestamp, with a verified historical completion receipt.
The repeat was separately excluded as an owner-confirmed duplicate. Original
rejections and office audit entries remain. The HP consumed both receipts and
reports no pending/review backlog. Current gauge and last-pull identity were
unchanged by recovery. The recovered load appears once in Mobile cloud history.

Worker checkpoints25364477, c3b8cdf6 and afa8ae04 reconcile a full day behind the
polling watermark and require fresh pagination rather than trusting an ancient
cached group notice. Nonadvancing history cannot certify coverage. Checkpoint
b4981b29 holds only a matching same-sender repeat after a completed original;
different-driver loads remain separate. Non-app duplicate responses go to office
review. All76 worker checks pass; relevant recovery and delivery suites also
pass on the HP. The actual receiver restarted using its existing linked profile,
returned to Connected/Ready and resumed all eight channels without a new QR.

Backend1ad6a2ce adds explicit per-well inventory_balance production mode. It uses
verified completed-load bottom endpoints, actual intervening withdrawals and
storage change over an observed6–24-hour window in the latest24 hours. It counts
late recovered loads and canonical edits, deduplicates packet identities, and
breaks at provisional/down/invalid evidence. No loading duration is assumed and
no target rate is forced. Other wells retain their existing method unless opted
in after capture/calibration verification. The proven continuous-hauling well
was opted in with a conditional configuration write and immutable private backup.

Live validation exposed an existing cold-cache transaction guard that could
silently skip current projections. Checkpoint8ec19198 retains a value listener
through each guarded transaction and always removes it afterward. The same
latest-pull guards remain. Forty-one focused backend checks pass, including
actual AFR entry-point replay, absent-current insertion, edit/delete refresh,
legacy behavior, cold-cache writes, owner/measurement preservation and recovery.
Both the lane and exact downloaded live-source overlay compile.

Source-only overlays are verified byte-for-byte for processIncomingPull(version100),
processDeleteRequest(86), processEditRequest(91), and reconcilePendingEditOutbox
(revision00008-pim). Runtime, trigger, configuration and IAM read-back matches the
prior deployments. No Hosting, rules or APK deployment was required. The final
three-file follow-up changes only refreshFlowWindow source/compiled/map files;
all other deployed archive bytes are preserved.

The actual current projection now matches the observed withdrawal/inventory
balance, and Mobile100 on the ZFold physically displays it. Historical raw
readings, quantities, current gauge and latest pull were unchanged during the
rate refresh. An isolated synthetic next-pull replay through the exact deployed
AFR entry point also matches the conservation calculation without cloud writes.
Historical production-log snapshots were retained as originally recorded; future
real pulls write the corrected live AFR. Exact customer values, identities,
screenshots, audit ledgers and deployment metadata remain private outside Git.
