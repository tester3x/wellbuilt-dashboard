# Equipment app access

Suite's ordinary Equipment card opened the standalone login because only the
shift-bound DVIR handoff had a PKCE integration. Added separate issue/exchange
callables for general Equipment access. No immutable contracts mirror or existing
DVIR/JSA/Tickets issuer/exchange behavior is changed.

Identity comes from verified callable Auth plus the canonical active driver.
Equipment app entitlement and company configuration are checked at issuance and
again after single-use code consumption. Only active_shift_required is irrelevant
to general browsing; commercial exclusions and invalid configuration still deny.
No shift/DVIR authority is created or mutated. Codes are 256-bit random, stored
only by hash, S256-bound, valid for 60 seconds and consumed transactionally.
Separate collection equipment_app_codes prevents DVIR-code confusion. expiresAt
is provided for TTL cleanup; logical expiry is enforced independently of cleanup.
Existing rate limits and generic callable errors apply.

Validation: 13 new handler checks cover off-shift entitlement, no shift writes,
wrong verifier, replay/concurrent redemption, expiration, revoked plan/driver,
company change and request identity injection. Existing complete SSO suites pass.
Only issueEquipmentAppSession and exchangeEquipmentAppSession are deployment
targets. Phone verification remains pending.

Deployed from a6bb004c on 2026-09-12. Both new functions are ACTIVE:
issueequipmentappsession-00001-weh (23:16:37 UTC) and
exchangeequipmentappsession-00001-liw (23:16:42 UTC). Live probes verify issuer
401 without Auth and exchange 403 invalid_grant for a fabricated code. Existing
shared issuer remains ssoissueauthorizationcode-00009-biz at 20:39:55 UTC;
shared exchange remains ssoexchangeauthorizationcode-00007-zex from August 23.
No rules, Hosting, plans, existing SSO functions or driver records were deployed
or modified by this deployment.
