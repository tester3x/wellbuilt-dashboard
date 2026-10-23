# Split pickup origin and barrel conservation

Extending a split family resolves its unique original pickup dispatch. A new
SWD continuation uses that pickup as its ticket source, and retains the actual
previous work stop separately. On-site service destinations remain work sites;
all continuations retain the same pickup reference and family ID.

The add-leg request can include explicitly confirmed `usedBbls`. The server
derives available barrels from the confirmed pickup invoice minus other closed
deliveries, validates the requested remainder and stamps the new continuation.
Retrying the same child ID with the same allocation is idempotent; changing the
allocation on that retry is a conflict.

Closing a split invoice runs in a Firestore transaction. Ticket A supplies the
load; later tickets consume it. A shared `split_load_ledgers` document serializes
concurrent closes and records pickup/used/remaining barrels. Retried invoice
writes replace that invoice's contribution, never add it again. Draft/cancelled
work does not consume water. Confirmed delivery cannot exceed the pickup, and a
later edit cannot silently overdraw it. Pending field-added children receive the
actual remainder when their parent closes, supporting restart recovery.

PW/SW pickup conversion validates the pickup and planned amounts. A departed
pickup may still be uploading; its actual confirmed close establishes the final
budget rather than guessing from an earlier dispatch target.

Preserved the current release's operator-access, field-added destination,
multi-load cycle and dispatch completion fixes. No Hosting assets or access
rules are deployed by this change. An earlier WIP implementation is preserved
at `c01cfaf4`; deploy from this integrated release checkpoint instead.

Validation:
- Functions TypeScript build passed.
- Add-leg, load-budget and packet-pin suites: 99 tests passed.
- Real compiled invoice callable with demo Firestore emulator: concurrent
  40+40 against 70 permits only one close; retry does not double count; a final
  30 exhausts the load; excess edits and forged family/company data are rejected;
  ordinary invoice close remains supported.
- Mobile source companion: explicit used/remainder modal, required split/heavy
  pickup target, planned pickup prefill, conversion and final-stop caps.

Live verification on October 23:
- `addSplitLeg`: source `c7e8faff`, ACTIVE revision `addsplitleg-00010-dih`.
- `startPickupSplit`: source `c7e8faff`, ACTIVE revision `startpickupsplit-00003-zen`.
- `upsertDriverInvoice`: source `e490160c`, ACTIVE revision `upsertdriverinvoice-00009-qew`.
- All three unauthenticated probes returned 401.

The invoice follow-up prevents detaching an existing split invoice from its
dispatch, locks the pickup quantity after deliveries, and stamps the original
source on SWD invoice close/replay. The emulator also verified that closing B
updates a pending field-added C with the actual remainder for restart recovery.
