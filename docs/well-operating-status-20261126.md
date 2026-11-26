# Route-authorized well operating status

WB T uses the canonical WB M assigned-route/assigned-well scope, including
company ownership and an active same-company profile. Local My Routes display
selections, driver roles and client flags do not grant server authority.

The active pickup form exposes Up/Down and a branded confirmation. Unassigned
drivers can submit a request instead. Dispatch/company administration review
requests explicitly in Location Review; driver-audience tokens cannot review.
The panel loads on demand without a polling timer. Status changes have stable
operation IDs, per-well serialization, expected-state checks and a dedicated
old/new/actor/time audit. Requests retain their decision and reviewer. Repeated
operation IDs cannot be rebound to another intent. Old-company tokens are denied
before reads or requests after a driver profile changes company.

An explicit status operation updates only the well's status/config flags,
outgoing status projection, and operating request/audit records. It does not
create a level report or pickup or change ticket/invoice/JSA/inspection records.
Ordinary WB T pickup packets still omit wellDown; existing backend authority
guards remain unchanged and tested. Signed records and Fold work were untouched.

Sources: initial feature d6d46cb2; reconciled already-published Dashboard source
fc346601; initial endpoint deployment9fd47a0e; admin capability alignment
b555e4e4; final driver company fence c87ea111.

Hosting source f574b1d44fc708af01cbda82763601aa05e0bf95 passed the canonical
release gates and all430 exported artifacts were verified against live bytes.
The web UI delta against the prior approved checkpoint was only the review
panel, Location Review insertion and deployed-callable inventory evidence.
Only driverWellOperatingStatus and reviewWellOperatingStatus were deployed.
No rules, indexes, other functions, Watchdog deliveries or historical resends.

Validation: Functions TypeScript build and43 tests across operating status/policy,
real handler mocks, retained pickup/edit authority, and packet guards/wiring.
Final live driver endpoint is ACTIVE at2026-11-26T20:49:57.279756737Z
from c87ea111; staff review is ACTIVE at2026-11-26T20:46:25.642586219Z
from b555e4e4. Downloaded driver compiled module byte matches SHA256
4bc849bbe7c022701da9eda1a8b53aeeb84dda7ba0dd9ae281ef92341554d9ee;
the staff handler body and unchanged shared helpers were verified against the
matching deployed source. Both live unauthenticated probes returned401
UNAUTHENTICATED without business writes. Private source archives are retained. Live database root write is
false with no direct client grants to the new operation/request/lock paths.

Native477 /1.0.306 built locally from fe312712, clean reconciled source, immutable
android-release-v477 reservation, existing release signer. Full Android release
gates and TypeScript passed. APK/package/signer/embedded feature verified, then
installed/read back on S24 only. Native source/evidence is in WB T's
docs/wbt477-well-operating-status-release.json. No Fold installation or taps.

Device test remains pending: a separate test job is at its new guided JSA,
page1 of4, awaiting Mike's review and certifications before the pickup form.
No device Up/Down change or pickup-preservation pass is claimed yet.
Private snapshots, device logs and real-record identifiers remain outside Git.


## Final owner-checkbox contract — WB T478

Mike clarified that visibility is not ownership. Only an exact well route in the active driver profile assignedRoutes permits changing status. assignedWells and WB M locally selected routes grant no status authority. Helpers see the saved Well down checkbox disabled and can submit an explicit Report from Well details. Owner edits remain local until Depart, then use the direct saveOnDepart action; a revoked owner is rejected, never silently turned into an approval request. Ordinary pickup packets do not set status.

Source0eb727b6 deployed only driverWellOperatingStatus under dashboard codebase. Live ACTIVE archive byte matched functions/lib/security/operational/wellOperatingStatus.js.12 targeted authorization/handler tests and TypeScript passed. Earlier40678df6 cold-cache lock release repair retained. Strict rules held; no Hosting/rules deployment in this follow-up.

Native S24 on478: checkbox draft did not change RTDB; Depart applied Burger1 Down exactly once without approval, and the pickup left it Down. Devices disconnected before returning this test well to Up. WBT source862b81f4, release receipt docs/wbt478-destination-commit-release.json. Fold got an in-place478 install only; no real job operated.
