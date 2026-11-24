# Queued DDJD cancellation support

Code-only checkpoint on `release/dashboard-pw-exception-scoped-20261119` from 3e7c23700f1d0f593142c2f9e27d3cf0a9d26075. Matching client changes are in WB Tickets `codex/wbt-enroute-20261014`, documented in `docs/queued-ddjd-offline-2026-11-24.md`.

`createDriverDispatchIfAbsent` writes a server-only immutable birth receipt (`driver_dispatch_births/{dispatchId}`) with the original authenticated company/driver and assignment commit timestamp. The dispatch carries that original timestamp for local navigation projection. Existing create-if-absent replays do not rewrite or backfill birth evidence.

`resolveDriverJobCancellation` retains `cancel_job` / `builder-v1`. A `pendingCreate: true` request resolves the assignment fence from the immutable birth receipt, never a caller timestamp or a mutable current assignment. It verifies company/driver, original driver builder, unchanged assignment, pending stage, absence of invoice and no split group. The ordinary cancellation and custody rules remain intact. The exact receipt replays idempotently. Missing birth evidence fails closed.

55 targeted Jest tests and TypeScript no-emit passed. Tests include transactional birth creation, lost-ack replay, cancellation before the upload timestamp, wrong owner, reassignment, already-started work, existing cancellation/custody/split behavior.

Not deployed. Before an app rollout, freshly reconcile the scoped live Functions source and deploy/verify only `createDriverDispatchIfAbsent` and `resolveDriverJobCancellation`. No Hosting/rules deployment, old-job migration, signed record change or load resend belongs to this update.
