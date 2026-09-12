# Minimal driver DVIR completion and historical recovery

Four new callables: recordDriverDvirCompletion, registerDriverDvirPostTrip,
resolveDriverDvirStatus and resolveEquipmentDvirEntry. Only deploy these named
functions in wellbuilt-sync. Local database/Firestore rules are stale and MUST NOT
be deployed with this change.

Subject comes from verified authentication and live canonical driver/profile checks.
Expected owner fields are assertions, never a selector. Equipment may attest signed
completion metadata; Suite can read its own status. Ledger phases are immutable with
idempotent retries. No full report, signature or photo is copied into this ledger.
The digest identifies the client report; it is not server proof of real inspection.

Server shift history normally establishes ownership. Older locally created periods
without server claims may register a pending recovery under their authenticated
driver's active newer period. Such rows have origin legacy_local_recovery and no
completion until Equipment submits a sealed report. No callable changes shift
authority, retroactively claims a shift or closes a current shift.

Entry chooses the oldest same-company/driver outstanding Post-Trip. Current Pre-Trip
completion alone does not redirect to Post-Trip. An old unsigned draft can be closed
with an explicit Post-Trip-only record; a missing Pre-Trip is never certified.

Validation: TypeScript build; 10 pure model tests; Firestore/RTDB emulator tests of
actual callable bodies covering unauthenticated, wrong-app, cross-driver, revoked
profile, immutable retries, recovery, legacy registration and unchanged authority.
Emulator invocation tests callable bodies rather than network JWT verification or
Firestore client rules. No synthetic completion is written to production.

Deployed September 12 at 18:08 UTC from 857c1412 using only the four explicitly
named dashboard-codebase functions. All four report ACTIVE, and each live HTTP
endpoint returns 401 UNAUTHENTICATED without a session. Downloaded deployed source
and compiled JavaScript match the committed implementation for all four functions.
No rules or Hosting target was deployed. Device completion validation remains pending.
