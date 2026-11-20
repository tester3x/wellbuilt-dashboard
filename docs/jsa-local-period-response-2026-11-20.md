# Local summary period response metadata

Online acknowledgments did not return their exact work-period ID. Tickets could
therefore only recover that membership join through an optional saved-history
cache download. Per-job display numbers are deliberately different and cannot
serve as the shared period key.

Existing acknowledgment, scope-read and saved-job responses now include optional
jsaPeriodId. It is derived from verified server scope/records, never client input.
Legacy already-recorded acknowledgments omit usable metadata if their stored
requirement key does not match. Missing/unverified signed artifacts still expose
no completed read. The response addition does not change Start/Close authority,
work-period transitions, signed snapshots or stored acknowledgments.

Deployed exact source aca84e5d (full hash in Git history) to only:
jsaAcknowledgeJobShift, jsaRecordJobShiftReadCoverage and jsaGetSavedJob.
All three independently verified ACTIVE, Node22, source hash
e245c394517c1f1adb82484d9caa33bb6bf0aa6a on November20. No Hosting/rules or other
Functions deployed. Initial unqualified filters matched nothing; deployment used
explicit dashboard codebase filters.

Functions TypeScript,33 focused saved-job/work-period/store tests and142 governed
receipt checks passed. An inadvertently broad Jest run also exposed seven
unrelated catalog/inventory/packet test-suite failures; these were not changed or
reported passing. Focused acceptance does not claim the whole repository suite
is green. The separate new external-assignment branch was reviewed as unrelated
and not merged for this scoped JSA response deployment.

Tickets418 consumes the response metadata into its existing owner-bound local
proof. Reading the Job Complete location list does not make a new Firebase call.
Private device logs/deployment logs remain outside Git in release artifacts.
