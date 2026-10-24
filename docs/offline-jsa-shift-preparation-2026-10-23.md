
## Exact delivery metadata read — deployed verification

Backend2e6475be adds only getDriverDeliverySnapshot. It returns narrowly
allowlisted metadata for one exact invoice, ticket or dispatch, deriving company
and driver ownership from the current canonical account. Confirmed absence is
explicit; revoked, foreign, malformed and wrong-app requests fail closed.

Deployment: ACTIVE getdriverdeliverysnapshot-00001-fih,2026-10-24 UTC.
Downloaded deployed lib/security/driverDeliverySnapshot.js byte-matches the
compiled checkpoint; unsigned POST returns401. Nine focused tests and Functions
build pass. No existing operational callable, rules or Hosting was deployed.

WB T6d53b1b uses the endpoint before close/photo merging and stage/completion
replay, retaining work on failed reads. Candidate240 physical acceptance remains
pending; this endpoint verification is not a completed phone-delivery claim.

## Confirmed photo binding and software-test cleanup endpoint

The exact snapshot endpoint revision getdriverdeliverysnapshot-00002-gas includes
server-owned dispatchId for obsolete accept replay validation. The closed invoice
and completed dispatch must agree bidirectionally; invoice_terminal alone never
retires an accept.

Photo evidence source377a2ab2/2e8f364c preserves confirmed cloud bindings and
settled validation data transactionally against late stale close writes. Six
focused merge/concurrency cases and Functions build passed. Source-only overlay
upsertdriverinvoice-00011-xaf is ACTIVE; every deployed archive byte matches the
prepared overlay, unrelated source/dependencies and service configuration/IAM
are preserved, and a valid unsigned invocation receives401. Physical S24 replay
confirmed all three Storage objects and canonical invoice references, empty
photo queue, and automatic office-alert resolution.

Source93e3da35 adds cancelAuthorizedSoftwareTestShift, scoped-deployed ACTIVE as
cancelauthorizedsoftwaretestshift-00001-ray. Downloaded compiled handler matches
source; valid unsigned invocation receives401. Twelve focused authorization,
fixture, inspection/activity, retry and rejection cases pass. This is a
narrow software-test cleanup operation, not relaxed ordinary shift cancellation.

It requires a protected operator-issued exact-period/exact-invoice manifest,
current authenticated Suite driver authority, only software-test-well closed
jobs with matching ticket proof, and no inspection or other shift activity.
Success creates an immutable audit in the existing cancellation collection,
consumes the authorization, advances authority and records shift_cancelled.
Original evidence is retained. Existing DVIR callbacks see that same cancellation
audit. No direct operational shift write is used by the test operator.
Suite96 will call this endpoint then use the normal signed durable ETC end.
Physical test cancellation/HOS cleanup remains pending at this checkpoint.
No rules, Hosting or unrelated functions were deployed.

Physical cleanup subsequently passed through Suite96 on S24: the driver-authenticated
operation consumed its protected exact-session authorization, produced the standard
cancellation audit retaining original login and three closed test fixtures,
advanced the authority and removed the active test period. No inspection exists.
The normal signed ETC end completed; independent ETC UI showed OFF SHIFT and
START SHIFT. Operational records were changed only by that verified endpoint.
