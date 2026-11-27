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


## Explicit company grants and shared local cache — final November26 update

This supersedes the earlier assignedRoutes-only authorization description. User clarified route access is not ownership. Source2585d67b requires assignedRoutes scope AND explicit primaryRoutes membership or primaryAllRoutes=true; viewer/inactive/cross-company profiles fail closed. Multiple drivers may hold the same route grant. Two Mike test profiles currently have an explicit all-routes primary grant; no profile grants were changed by this task. Company staff assignment UI/model already supported per-driver primary grants, with no single-owner restriction. Live RTDB profiles/$driverId .write=false and root .write=false were independently read back: drivers cannot directly self-grant these fields.

Driver function deployed ACTIVE with byte-matched wellOperatingPolicy.js.39 primary/handler/tank tests passed. Source27ab0567 adds wellOperatingGrant to the already-needed bootstrapWbmSession response, from the existing profile read. No extra database read or permission call. Bootstrap deployed ACTIVE with byte-matched wbmBootstrap.js;28 bootstrap/status/contract tests and TypeScript passed. No Hosting or rules deployment.

WBT480 consumes this snapshot in a WB-account/login/driver/company-scoped24h local cache. Rendering wells performs no status/permission HTTP request. Explicit writes remain server-authorized. Off-shift work needs only WB sign-in, not a shift. Signed-out/new-account/company fences and expiry tests passed.100 repeated cache checks had no extra disk/network fetch; same-login restart restored disk state in tests. Native offline-radio verification was blocked by automatic approval review and not executed. S24480 installed, Fold480 pending USB; earlier479S24 test21024 closed with one Down operation and original10bbl120/117inch pickup preserved. Gab1 and Burger1 Up flags restored with explicit cleanup audits; signed records untouched. Strict rules remain held.
