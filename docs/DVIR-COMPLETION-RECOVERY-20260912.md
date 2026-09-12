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

Follow-up: resolveDriverDvirRecovery finds the current owner's oldest pending
Post-Trip outside the server's active period, including when no period is open.
recordDriverDvirRecoveryFeedback accepts optional bounded reason/notes separately
from signed report fields. Ownership, profile activity and recovery state are
rechecked server-side; feedback cannot create a completion or modify shift authority.

Equipment authorization now permits a Post-Trip-only recovery when the server
ledger proves the same driver's unfinished inspection outside the active period.
The exception applies only to shift requirements for Equipment; authentication,
company contract, DVIR capability and app entitlement checks still apply. Pre-Trip,
other audiences, completed records and foreign records cannot use the exception.
No protocol identity fields or permissive client rules were added.

Validation: 14 model tests; existing SSO bridge/wrapper/entitlement suites including
112 entitlement checks; real callable-body Firestore/RTDB emulator tests for new
lookup/feedback, off-shift recovery proof and unchanged shift authority. Updated
deployment targets are only resolveEquipmentDvirEntry, resolveDriverDvirRecovery,
recordDriverDvirRecoveryFeedback and ssoIssueAuthorizationCode. Deployment pending.

Deployed those four targets from ac11ee4f on September 12 at 20:26 UTC. Each is
ACTIVE and returns HTTP 401 UNAUTHENTICATED to a valid unauthenticated probe.
Downloaded deployment archives match committed recovery/SSO TypeScript and compiled
JavaScript on all four functions. No rules or Hosting targets were deployed.

Shared-source compatibility correction: the local audit base contained contracts
0.4 and pre-JSA SSO issuance, while the unchanged live exchange function's August
23 source archive contains contracts 0.5 and server-authored JSA bindings. The
20:26 issuance update therefore omitted that existing audience support. Restored
the deployed immutable 0.5 mirror, its verifier, JSA authorization and shared SSO
source; reapplied only the Equipment Post-Trip recovery exception to that source.
The exchange source is now aligned locally but its live function is unchanged.

The full SSO tests now include the restored JSA spine: 115 entitlement checks and
14 JSA issuance/exchange checks pass, including off-shift owner-operator policy,
shift-required customers, inconsistent/absent authority, exclusions and exact
server binding round-trip. The mirror verifier confirms 59 immutable files.
Redeploy only ssoIssueAuthorizationCode for this compatibility correction.
