# Office escalation for stuck mobile updates — source checkpoint

The pending badge opens a detail sheet; it is not an unsolicited modal. Mobile
drivers should see saved/syncing status rather than debugging operation names.
This work adds an office destination for genuinely stuck delivery.

WB T records an incident for a rejected update, or after at least five failed
attempts when the queued item is at least ten minutes old. Ordinary disconnected
waiting does not escalate. Reports persist locally and retry through the shared
delivery scheduler. Owner-scoped journals and immutable queue-owner bindings
prevent a later login from inheriting another driver's incidents. Pre-upgrade
unbound entries are not silently assigned to the next account. Unreadable queues
and deliberate recovery holds cannot prove an incident resolved.

`reportDriverSyncAlert` derives driver/company from authenticated claims plus
current canonical credential/profile liveness. Client authority fields are
rejected. Existing invoice/dispatch ownership is checked. Stable incident IDs
deduplicate retries. Resolution is permanent for each operation ID, including
when an initial network response was lost. Reports contain operation references,
reason categories and counters, never job payloads, photos, signatures or tokens.

`adminListSyncAlerts` requires server-backed platform administration or a trusted
company `manageDrivers` capability. Company users cannot request another tenant;
platform admins explicitly select an operating company. Reads are capped at 50
open incidents, with no client direct-write rules or rules deployment required.

Dashboard notification bell and `/sync-alerts` show the incidents. Staff defaults
include the new category with a one-time preference migration. Reads happen on
entry, returning focus/visibility and opening the bell; there is no polling
timer. An idle, continuously foregrounded dashboard does not receive a live push.
The review page has a manual Refresh. Temporary read failures retain known
incidents; changing user/company clears the prior scope and ignores late replies.
No email, WhatsApp or SMS is sent.

Validation: six backend tests cover authority injection, eligibility, duplicate
delivery, ambiguous replies, irreversible resolution, revoked/foreign identities,
resource ownership and staff tenant containment. Backend and Dashboard TypeScript
checks pass. The preference migration check passes. Companion WB T lifecycle tests
exercise durable delivery, retries, account switching and unreadable snapshots.

Not built or deployed. Before runtime rollout, deploy only the two reviewed
callables from the current authoritative Functions baseline, then release the
Dashboard through its certified Hosting branch/preflight and ship the companion
WB T changes. Do not deploy this checkout's stale rules or replace live unrelated
Functions. The unrelated untracked `app.json` is excluded from this checkpoint.
