# Suggested-driver availability and status

The idle-driver estimator previously treated every open invoice as unfinished
physical work. An old open draft on a dismissed dispatch therefore blocked a
driver with no active job and fresh GPS. A draft now stops blocking availability
only when its exact dispatch is terminal (completed, cancelled, declined or
dismissed), matched to the same driver/company. A truly unresolved open invoice
still withholds an estimate. This changes the read model, not job/invoice data.

PW and SW selectors display three distinct signals: recent verified account
activity/last recorded sign-out/unverified account status; governed on/off-shift
state; and current job/paused/no active job/needs-review state. Queue count remains
separate. Account uncertainty does not mean signed out and does not exclude a
driver. No shift start is required for an advisory estimate.

The bounded staffGetDispatchDriverSignals read is company scoped and uses only
server-authored secure-login or own-profile-hydration evidence matched to the
canonical driver ID. A newer canonical sign-out is shown as last recorded
sign-out. Recent verification is limited to 30 minutes; older/missing evidence
is unverified, never fabricated live presence. This is not a continuous device
online or GPS feed. No phone application changes are required for this read.

Account status is fetched when opening/refreshing the comparison. Missing timing
history no longer disables an idle driver's independent road estimate; missing
current open-work data still withholds it. Existing paid-road requests remain
explicit open/refresh only, with current GPS freshness and identity boundaries
unchanged. Shift reads now carry the selected company context.

Verification includes terminal-draft regression, real orphan and cross-driver/
tenant rejection, nearest-free-driver ranking, canonical account matching,
future/stale authentication evidence, sign-out ordering, staff scope, no status
polling, status failure fallback, selectable unknown rows, and responsive layout.

A private read-only comparison against actual pre-dispatch work evidence and
live road travel restored the affected driver's withheld arrival estimate for
the reported pickup and the next requested pickup. No dispatch, invoice, shift, driver
profile or job record was written by this investigation. Raw records, driver
identities, coordinates, keys and screenshots remain outside Git.

Released runtime source: `983c2ae4cb895063661182acf47e92ced024a3b9`.
Mandatory preflight passed: 463 library tests passed, zero failed, one existing
skip; retained header, navigation, dispatch, manual Watchdog refresh, health,
review recovery, demo/media and completed-date checks passed. All 362 live
Hosting artifacts byte-match the build and the approved checkpoint advanced
through the normal postdeploy hook. The account signal callable is ACTIVE from
backend source `85b0ddb2`; signed-out requests return 401. No phone build or
database/Firestore/Storage rules deployment was performed.
