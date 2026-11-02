# Tank information deployment

Source: `5c49d257adf567361ce5ce34c71146987c6cb06f`.

Only these new functions were deployed to `wellbuilt-sync`, in codebase
`dashboard`: `getWbmTankInfo`, `saveWbmTankInfo`,
`staffGetPrimaryRouteAssignments`, `staffWritePrimaryRouteAssignment`.
The release used an isolated source tree with a minimal export index. Existing
pull processors, other callables and database rules were not deployed.

All four live functions were verified ACTIVE and rejected anonymous calls with
HTTP 401. Their deployed source archive matched the isolated release's index,
tank model/callables, primary-route model/staff callables and compiled index.
The staff endpoints were then added to Dashboard's verified-callable fixture.

Primary-route designation is independent of viewing assignments and canonical
roles. All-routes primary authority does not add viewing access. Requested driver
designations were applied with conditional writes after matching canonical
active profiles and credentials, preserving their viewing assignments and roles.
Before/after evidence is retained privately outside Git.

Tank edits have field allowlists, company/view scope checks, revision CAS,
operation-id/digest replay protection and atomic audit/receipt persistence.
NDIC identity, route, company and authority fields cannot be edited. Replays of
an applied operation are acknowledged without applying it twice. Connected-bank
calibration is derived from active count and per-tank calibration.

Validation: 37 targeted tank, callable, assignment-scope and bootstrap tests passed;
TypeScript checking passed. Existing live rules deny client writes to canonical
driver profiles and well configuration. Dashboard source/release
`58dc33563e3d8a65f8147f3f868f75747c4eac09` passed release preflight and hosted-byte
verification. Mobile feature source: `9fca17134447387466b2030c3367d3179f44a1d2`.
