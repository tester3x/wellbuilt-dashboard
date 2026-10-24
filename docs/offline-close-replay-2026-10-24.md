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
