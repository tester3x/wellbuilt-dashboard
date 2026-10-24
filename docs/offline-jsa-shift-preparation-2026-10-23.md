
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
