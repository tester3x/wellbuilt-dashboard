# Separate cancelled/dismissed dispatch history

Branch: `release/dashboard-compact-identity-20261015`.

Cancelled, declined and dismissed cards now appear in a separate Cancelled / Dismissed tab and count, including `?tab=cancelled`. Active Jobs and its count exclude those statuses. Existing reassign/dismiss actions remain on cancelled/declined cards; dismissed history is read-only. Reuses the existing cards and dismissal confirmation, without changing cancellation approval or writing live operational records. Tab header wraps at narrow detached-pane widths. History rendering does not prune the saved expanded active-driver groups.

Read-only identity audit found three older active dispatches linked to invoices already closed. They are distinct from the current three-member multi-haul the user is finishing. Current load and stale records were left untouched; private IDs/evidence remain outside Git. This display separation does not itself repair those historical dispatch statuses. Re-check after the user's current Close All before any live reconciliation, and preserve invoice/ticket/measurement history.

Validation: four active/history classification tests passed; TypeScript passed; production Next build passed. No Hosting deployment; desktop owns dashboard deployment. Pre-existing untracked app.json left untouched. Device photo behavior was investigated separately, with no WB T edits in this dashboard change.

Follow-up (2026-10-24): The live tab is a Dispatch decision queue. Declined jobs and cancelled jobs that have not been reassigned remain there with Reassign and Dismiss actions. Dismiss opens the existing confirmation with an optional reason and saves the dismissed status; the card then leaves the queue. Reassigning a cancelled job also removes its old card. Previously dismissed and reassigned records remain saved but no longer occupy the decision queue.
