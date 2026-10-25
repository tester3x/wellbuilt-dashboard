# Suite shift JSA summary reader - 2026-10-19

Source checkpoint for a new read-only callable jsaShiftSummary. No APK, Hosting, rules or data migration is part of this change. Deployment verification follows in this note after completion.

Identity is derived by resolveSubject from the verified driver token and canonical active driver/company records. Input is only protocolVersion1 and optional exact shiftId (YYYY-MM-DD_HHMMSS); client company/driver/date fields are rejected. Without explicit scope, the server reads the driver's canonical openPeriodId or lastClosedPeriodId. No date fallback and no work-period creation, closure, signature or acknowledgement writes.

Projection matches owned jsa_work_periods by shiftId, including contexts whose reads occurred before shift attachment. Requests, job acknowledgements and once-per-shift coverage are queried by canonical company+driver+exact shift/context, deduplicated across those queries. This does not scan lifetime history. Immutable full-read artifacts are owner/job/action matched and reparsed before counting. New job acknowledgements/coverage require their explicit fullReadId and matching context. Legacy acknowledgements lacking both fullReadId and requirementKey may reference an earlier verified legacy full read in that exact shift, matching existing saved-job compatibility. No calendar-day or unrelated standalone record substitution.

Response allowlists counts, first-read timestamp, JSA numbers, selected shift and period lifecycle. It omits signatures, notes, tokens, receipt handles and actor metadata. Recorded describes verified evidence, not a blanket assertion that every company obligation was fulfilled. Missing, partial and unavailable evidence stay distinct. More than2000 matching rows/20 contexts/250 full-read artifacts refuses instead of returning an incomplete successful projection.

Validation: Functions compilation and31 tests across summary, saved-job and work-period suites passed. Actual production query shapes (including new-context lookup fields) succeeded read-only without new indexes. Read-only projection of the latest closed owner shift found1 signed read and1 legacy acknowledgement, issues0. No records changed. Private audit evidence remains outside Git.

Companion Suite source uses this callable, preserves shiftId in server event parsing and retains exact finalized DVIR shift scope after active storage clears. JSA check/retry is independent of work statistics. Old day-status queries and unreachable legacy shift-end acknowledgement/launch handlers are removed. Full Suite tsc and37 summary/client tests passed. New APK and authenticated on-device verification remain pending.

## Live deployment verified

Backend source762648176616cf95813a667ff805533b0f38f214 was deployed with only functions:dashboard:jsaShiftSummary. Verified ACTIVE at2026-10-19T06:16:21Z, revision jsashiftsummary-00001-weg, updateTime2026-10-19T06:15:37Z. An actual signed-out callable request returned401. Existing17 JSA functions, Hosting, rules and indexes were not redeployed. Signed-in phone invocation remains pending the next Suite APK; the production datastore projection was checked read-only separately as described above.

Suite source b14c052f60ad592937f6a54807dfd77e4204a92a is pushed and wired to this endpoint. No APK build/install was performed. Deployment log and private metadata receipts remain in C:/dev/tmp outside Git.
