# Watchdog photo fallback recursion — November 24, 2026

## Verified incident and containment

Cloud Monitoring reported 67,523 Cloud Run requests for
`processwatchdogphotofallback` in the sampled recent hour. Minute samples before
containment showed 1,227–1,306 requests/minute, consistent with the reported
roughly 21/second. These are function requests, not a count of model inferences
or individual Firestore reads. Other Watchdog services were much quieter.

Cloud Audit Logs show a separate actor initiated DeleteFunction at
2026-11-24T23:51:54Z, completed at 23:52:05Z (5:52 PM Central). This task did
not delete the function. It was absent in the subsequent Functions inventory.
Monitoring showed 43 tail requests followed by multiple zero-request minutes
from approximately 5:54 PM Central onward. Do not credit the subsequent policy
change for the earlier stop.

Mike authorized investigation, stopping the flood and repairing needed code.
This task changed only `watchdog_v2_config/laptop.cloudPhotoFallback.enabled`
from true to false, using the original document update-time precondition. A
recursive field comparison of before/after confirmed no other policy change.
The first verification compared serialized key order and reported a mismatch;
the subsequent field comparison proved the sole intended boolean change.
Private policy snapshots and operational evidence remain outside Git.

No loads, receipts, original photos, worker queues, signatures or JSA records
were deleted or resent. The ROG's pinned SSH address was unreachable from this
laptop. No claim is made that its local worker was paused. Local OCR/intake and
photo inbox were not disabled by this task.

## Root cause and history

Nov. 17 photo inbox: c57fddac / 70206659. Nov. 18 worker coordination and
reports: fb0be3a1 (equivalent prepared f70a74e0). The recursive cloud fallback
was introduced in 77e6eb4e on Nov. 20, with further guards d9da3984/f0d6de53 and
unidentified-channel support in 85b7708d on Nov. 22.

The Firestore trigger watches the same photo document that it updates with
`cloudFallback`. Its `set(..., {merge:true})` retained omitted result fields.
After `delivery_submitted` became `{state:'already_recorded'}`, old `bottomFeet`
and `delivery.packetId` stayed in the stored audit. `fallbackAuditChanged` then
continued to see differences on every invocation. Each update changed
`checkedAt`, creating another event. Five of six sampled live already-recorded
audits retained both stale fields, matching the reproduced failure.

The existing test covered repeating an identical already-recorded result, but
not transition from a richer merged result. Message/image claims still bound
model and delivery work; request counts must not be represented as repeated AI
reads or duplicate loads without separate evidence.

## Repair and verification

- Compare only source inputs before any cloud I/O. Ignore audit-only writes and
  unchanged worker timestamps, while allowing image/readiness/row/source edits.
- Replace the entire audit map through `update({cloudFallback: ...})` so omitted
  old fields cannot survive a state transition.
- Return immediately when the automatic-fallback policy is disabled.
- New tests reproduce the retained-field transition and audit-only event, and
  verify real input edits still proceed. Functions TypeScript compilation and
  all 23 Watchdog suites / 179 tests passed.

An initial unsupported Jest filtering flag ran unrelated baseline suites and
was interrupted; a subsequent wrong working-directory invocation found no
tests. Neither is claimed as a pass. The successful final run used explicit
absolute test paths from the Functions directory.

At the incident checkpoint the source repair was prepared, not deployed. Do not blindly recreate the
deleted function while another operator/AI's containment action is unresolved.
Keep fallback disabled. Before recreation, reconcile the deleted live source
archive and coordinate the other actor. Deploy only this repaired function,
validate a synthetic audit transition without load delivery, and observe flat
request counts before controlled reactivation. Preserve the message-ID barrier.
The separate signed-JSA/receipt audit deployment remains unauthorized.

Mike subsequently confirmed the deletion and explicitly authorized a scoped
delivery-off canary and conditional activation. See
[the verified redeployment record](watchdog-photo-fallback-redeployment-2026-11-24.md).
