# Offline group close replay

The S24 acceptance test caught two contract gaps before live WB T installation.
The legacy JSA location mirror uses unauthenticated Firestore REST, denied by
the deployed driver ownership rules. A background XHR completion additionally
caused transport timeouts. The authenticated delivery snapshot excluded the
invoice haul group, preventing an older queued ticket from reconciling its
frozen group finish time.

Added haulGroupId to the existing owner-checked invoice metadata projection.
Added project_locations to jsaOfflineShift. It requires the exact immutable
event to hash-match a server-confirmed receipt, owned grant and owned invoice;
location names come from that invoice. The projection merges names in a
transaction into the grant's original shift, preserves existing metadata and
never changes JSA completion or acknowledgment. Off mode writes no location
mirror. Existing prepare/commit operations retain their validation.

Forty focused JSA evidence/projection and delivery snapshot tests pass; the
Functions TypeScript build passes. Before editing, both live function source
archives matched this checkout's checkpoint baseline. Only jsaOfflineShift and
getDriverDeliverySnapshot are intended for deployment. No Hosting or rules
deployment is involved. Physical replacement APK testing is still pending.

Deployed only those two Functions from source 5110d3ac. Both report ACTIVE:
jsaofflineshift-00003-huf and getdriverdeliverysnapshot-00003-koh. Downloaded
the deployed source archives and verified exact source matches for both
handlers and the new projection module. No Dashboard Hosting or rules changed.

The replacement T245 physical test passed offline Close All, cold restart and
automatic background reconnect: both invoices closed, both dispatches completed,
one ticket and one monitoring pull per pickup, original close minute retained,
and the original shift's JSA location mirror deduplicated. T245 and M107 are
installed on the ZFold after S24 acceptance. Private evidence is outside Git.

Software-test cleanup initially refused the second test pickup, because the
previous dedicated endpoint hardcoded Test Well. It now additionally accepts
an operator-protected exact invoice/well/ticket proof in the existing grant.
The driver cannot submit or broaden this proof. Ownership, operator, one BBL,
closed status, software-only notes, exact fixture set, no inspection, no real
shift activity and audit preservation still apply. Thirteen cleanup tests and
Functions build pass; deployed baseline source was verified before this change.

Deployed only cancelAuthorizedSoftwareTestShift from a30303de; ACTIVE revision
cancelauthorizedsoftwaretestshift-00002-xad, deployed source archive byte-verified.
Using Suite96's dedicated authorized-software-test screen, the operator-pinned
four-fixture session cancelled successfully. Server authority has no open
period, daily currentShiftId is empty, cancellation audit preserves the original
start and fixtures, and no DVIR exists. Suite confirmed "Test cancelled and HOS
ended" and returned to Suite home. The initial ordinary cancellation attempt
was correctly refused by the HOS guard and did not mutate the shift.
