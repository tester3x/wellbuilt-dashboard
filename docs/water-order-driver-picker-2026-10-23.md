# Water Orders large-crew selector

Replace the full wrapping checkbox roster with a compact collapsed summary and
a searchable, scrollable picker. The closed view shows selection/availability
counts and at most two selected names plus a remaining count. Opening it exposes
All, On shift and Selected filters, explicit Select shown and Clear selection
actions, native checkbox rows and Done/Escape closing with focus restored.

The list has a bounded height at phone and desktop sizes. Verified on-shift
drivers sort first; the existing governed shift reader supplies labels. Unknown
shift status stays unverified. Off-shift drivers remain selectable in All.
Names use the shared operational-name policy. Search can match a known account
alias without displaying it as a driver name.

Selections survive searching and filtering, with existing planning order
preserved. A roster change cannot silently drop an unavailable selected driver;
the picker shows a review message and existing planning validation remains.
Busy/read-only/saved-order states disable selection changes.

No new Firebase queries, subscriptions, paid road calls, automatic assignments,
order planning or dispatch-write behavior is introduced. The picker receives the
already company-scoped roster and existing shift views from Dispatch.

Playwright verification uses 42 synthetic drivers, 35 on shift, and checks bulk
selection, hidden selection retention, order preservation, missing-roster keys,
compact 35-driver summary, internal scrolling, native checkbox use, keyboard
closing, protected names and no horizontal overflow at 320/344/768/1280 pixels.
The regression and route integration checks are part of mandatory Hosting
preflight. No customer order, invoice, shift or driver record is modified.

Deployed Hosting source 894ed5a73a58cda9691af9b38a4f9fe82c653826 through the
canonical guarded deployment on October 23. Fresh production build, TypeScript
and mandatory preflight checks passed, including the 42-driver browser test.
Postdeploy verified all 362 live exported artifacts against the build and
advanced the shared approved checkpoint to that source. No APK, backend or
security rules deployment was needed.
