# Dwyer cloud OCR fallback

Local OCR remains first. The updated worker uploads unresolved photos only;
successful local reads use the existing structured intake/receipt metadata.
Health heartbeats remain enabled. The worker patch requires a ROG runtime update;
deploying Functions alone cannot change an installed worker's upload behavior.

`processWatchdogPhotoFallback` watches the private verified photo inbox. It is
disabled unless `watchdog_v2_config/laptop.cloudPhotoFallback.enabled` is true
and `enabledAfterMs` permits that observation. Only one locally unreadable,
tag-verified Dwyer row is eligible. Good Shepherd, uncertain well identity,
already readable rows, bad original timestamps and unverified photos stay out.

Two independent full-image Vertex reads must identify WTR3/LT5103 and return the
same bounded decimal-feet display. No neighboring-level/volume inference, unit
conversion, generated top, barrel override or self-reported confidence score
authorizes a load. Printed foreign pad identifiers force review. Schema output
is still strictly validated in code. Incomplete/model failures remain review.

Message and image/model/prompt claims are written before inference. Duplicate
events and shared image hashes cannot automatically invoke the model again.
A lost/unknown inference result requires review, not another billed retry.
The daily cap defaults to 25 photos and cannot exceed 50. These are spending
bounds, not a claim that the vision model cannot make a reading error.

`allowDelivery` defaults false. In read-only activation, matching reads are saved
for review without submitting anything. After acceptance, allowDelivery true uses
the existing HMAC intake with original source message ID/image digest. It does
not use an office override. Existing haul, calibration and sender controls and
transactional reservations remain final authority. Receipt lookup runs before
inference and again before delivery. Already handled historical photos do not
invoke AI or create another load.

The new worker periodically checks held-photo receipts, then clears the local
hold only after the signed server reports exactly one recorded packet. It never
imports another load while reconciling. Completed photos stop those checks.
Subsequent inbox completion checks reuse the verified Storage generation rather
than downloading and hashing the original image again.

Implementation uses the documented Vertex GenerateContent REST API and structured
output schema. Model lifecycle was checked against Google's current documentation:
https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions
https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/inference
https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output

Read-only live evaluation used the two privately held originals, with no intake
calls. Both independent passes agreed on each image. One result disagreed with
the earlier manually entered value; the owner subsequently confirmed the cloud
reading. Both fixtures now match confirmed readings. The existing affected
receipt was separately corrected through the canonical edit pipeline and its
message ledger reconciled after completion; no replacement load was submitted.
Private images, readings, correction audit and receipts stay outside Git.

A deployed-runtime test cloned one verified private original into an explicitly
synthetic inbox item with allowDelivery false. The function's own ADC identity,
Storage digest check and both model reads succeeded. Both results matched the
confirmed fixture. No message delivery or reservation was created. The synthetic
inbox item, job and Storage object were removed after verification; the actual
inference cache and budget count remain as evidence of model work performed.

Edited source snapshots and any non-OCR hold (including duplicate warnings)
remain review. Source identity is checked again immediately before intake.
All 172 Watchdog backend tests passed before the final duplicate-hold assertion;
the final focused fallback suite passed 19 tests. The worker default suite passed
82 tests with three optional fixtures skipped; seven focused worker tests passed.

Both phones were checked first: JSA120 and Tickets414. The fourteen-hour JSA rule
remains deployed server-side and requires no APK for this change. No phone app,
open job, shift or JSA signature was changed during fallback work.

## Deployed and activated

Final trigger source: f0d6de53259a2e39a246ebb21a43a62d8db7ce74. Independently
verified ACTIVE, Node22, Firebase hash 39e03917b3351433cc220f1e6e05eef80daeb23a.
The inbox sync endpoint was updated from d9da3984; listWatchdogPhotoInbox from
77e6eb4e. Only these three Functions were deployed; no rules, Hosting, unrelated
Functions, APK or phone install was performed.

Following confirmed-original and deployed-runtime tests, cloudPhotoFallback was
armed with enabled true, allowDelivery true, maxDailyPhotos 25, and a prospective
cutoff of 2026-11-20T16:19:23.000Z. Existing configuration fields were preserved
with an update-time precondition. No historical messages were requeued. Next
real-photo automatic delivery remains a separate acceptance check.

ROG remains on a5ec8306 with nine healthy capture channels. The unresolved-only
upload and cloud-receipt reconciliation worker patch is NOT installed yet: the
laptop is on the phone hotspot and cannot reach the ROG's home LAN. Current ROG
mirroring already allows the cloud fallback to run, but successful local photos
will continue uploading until that runtime patch is installed. Its local review
count may also retain already handled photos until receipt reconciliation lands.

Prepared runtime bundle (outside Git):
watchdog-fallback-d9da3984eb92d0b329b666aeb266e3ec75edde98.zip.
The prepared runtime source is d9da3984eb92d0b329b666aeb266e3ec75edde98,
and its ZIP SHA256
is b13bfc3e66d2dd056360a9dc0b0cc71c887bd776db57efd84174cacb3fbd51eb.
Preserve the ROG queue/session, deploy in its existing LocalAppData runtime
layout, verify the manifest/full source, and repeat health/receipt checks before
calling the bandwidth reduction installed. This is a pending home-network step.
