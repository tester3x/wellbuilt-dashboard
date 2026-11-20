# External assignment delivery — first vertical slice

This slice adds a dispatcher-only, company-scoped lane for assigning an existing
Dashboard dispatch to an external company driver who does not use WB Mobile.
It is independent of personal chat, staff chat, and dispatch chat.

## Finished in this slice

- A company-scoped external-driver roster with strict name, E.164 phone, active,
  and SMS/WhatsApp channel validation.
- A provider-agnostic `ExternalDeliveryProvider` interface.
- A production-safe default provider that performs no network I/O and returns
  `unconfigured`.
- Durable delivery roots plus immutable numbered revisions for initial assignment,
  retry, reassignment, and cancellation.
- The truthful delivery status vocabulary: `queued`, `sent`, `delivered`,
  `accepted`, `declined`, and `failed`. Cancellation is kept as separate assignment
  state so it never rewrites delivery truth.
- Deterministic create idempotency, per-mutation idempotency hashes, tenant checks
  against both the dispatch and roster record, and retry-only-from-failed checks.
- A Dispatch Jobs panel for roster entry, existing-job selection, delivery attempts,
  retry, reassignment, cancellation, and truthful `provider unconfigured / not sent`
  reporting.
- Local unit coverage, including a mock provider that exists only in the test file.

## Intentionally not wired

- No SMS or WhatsApp provider, credentials, SDK, webhook, or network call exists.
  Every current delivery attempt is durably finalized as `failed` with
  `provider_unconfigured` and `notSent: true`.
- No recipient acceptance/decline endpoint exists. Valid delivered/accepted/declined
  transitions are modeled and tested, but publishing a response endpoint requires a
  reviewed, expiring, single-use recipient authentication design.
- No delivery-status provider webhook exists. `sent` and `delivered` cannot be
  reported until a configured provider supplies verifiable receipts.
- This slice does not modify the native WB-T driver roster or native dispatch
  assignment path. It links an external delivery record to an existing dispatch.
- No Firebase Functions, Hosting, Firestore rules, or indexes are deployed by this
  work. The callable and UI require a separately authorized, reviewed release.
