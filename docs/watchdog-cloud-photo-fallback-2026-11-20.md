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
calls. Both model passes agreed on each image, but one result disagreed with the
earlier human-entered value. That ground-truth discrepancy requires verification;
it is not a passed accuracy test. Auto delivery must remain off until resolved.
Private images, outputs and receipts stay outside Git. No existing receipt was
changed during this evaluation.
