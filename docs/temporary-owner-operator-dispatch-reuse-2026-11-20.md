# External-driver dispatch reuse for temporary owner-operators

Status: design investigation only. No temporary-contractor accountless flow has been enabled or deployed.

## Current implementation evidence
- External Assignment Delivery models an external company driver by company, name, E.164 phone, active status, and SMS/WhatsApp channel. It attaches a durable assignment delivery to an existing company dispatch. It does not provision a WB-M identity.
- The provider currently returns `unconfigured`; no SMS/WhatsApp messages are sent. Driver acceptance/decline is modeled but there is no authenticated recipient endpoint or receipt webhook.
- Employees / driver administration provisions secure login credentials. `temporary` in driver authentication means a first-login passcode change is required, **not** time-boxed temporary contractor access. Client provisioning currently sends `temporary: false` because the forced reset lifecycle is incomplete.
- WB-M execution, tickets, and safety operations use secure driver identity. No-login assignment receipt must not be treated as authority to submit or alter those records.

## Proposed product split
1. **Independent Dispatch package:** operational job package for customers who dispatch outside drivers without using the complete WellBuilt driver suite. Company activates package in Settings; staff permissions govern operations. Subscription tiers are separate commercial policy.
2. **Full-suite company external driver mode:** optionally use the *same delivery engine* to assign jobs to temporary outside owner-operators / leased operators. Do not require or silently add the Independent Dispatch package to a water-hauler's job packages; this should have its own explicit company entitlement, approved by WellBuilt admin.
3. **Lightweight recipient flow:** one job-bound, company-bound, recipient-bound expiring link to view minimal assignment details, accept/decline, and optionally acknowledge arrival/completion under a reviewed security design. Tokens must be unguessable, stored hashed, one-use for mutations, revocable on cancel/reassign, time-limited, anti-replay and rate-limited. SMS possession alone is not proof of permanent identity.
4. **Full WB workflows:** ticket entry, photos, JSA/DVIR, tank levels, HOS and other durable operational activity still require a driver identity or a separate explicitly designed scoped short-lived contractor authorization. Never let the external link write regular WB-M data as if it were a real account.

## Immediate package gate checkpoint
- The current feature branch hides the External Drivers panel unless the viewed company has exact `activePackages: ['independent-dispatch', ...]`, and the callable applies the same check to the trusted staff member's company.
- The current `activePackages` field is a company operational setting editable by authenticated staff in the existing configuration model, **not cryptographically protected paid subscription enforcement**. The commercial plan mechanism is separate and still largely inert. Billing entitlement enforcement needs a separate approved design.
- Existing Liquid Gold water-hauling package is unchanged. The feature is not automatically granted to all top-tier subscribers.
- A `job_packages/independent-dispatch` catalog entry and full generic dispatch-job builder must be created and reviewed separately before calling the product a complete Independent Dispatch package.
- Do not deploy this intermediate gate before the catalog and operational rollout are reviewed, because otherwise the currently available panel becomes hidden for everyone.

## Open product choices
- Which guest actions are allowed with no login: view + accept/decline only, or arrival/completion acknowledgements too?
- Does a full-suite hauler enable outside-driver delivery per company, per dispatcher, or per individual job?
- What minimum identity proof and ticket/audit retention are required for each regulated workflow?

No other feature has been coded for temporary owner-operators at this stage.

## Verified multi-company identity blocker (2026-11-20)
- Current `requireSecureDriver` trusts one `companyId` from the Firebase Auth driver claim or canonical profile and returns that single company.
- The governed initial binding in `companyBinding.ts` explicitly refuses an already-bound driver working for a different company. It is not a general multi-company membership service.
- `staffWriteDispatch.ts` refuses canonical driver assignments when profile company differs from dispatch company (outside the legacy well-pool exception).
- Therefore **one WB-M login operating across several companies is NOT supported today**. Do not grant cross-tenant access by changing a driver's canonical `companyId`, duplicating credentials, guessing identity from phone/name, or disabling this check.

### Proposed separation (not implemented)
1. A stable global, verified driver ID belongs to the person. A driver-to-company membership is a separate server-owned record with one company's scoped role, enable/disable dates, and dispatch permissions. A company can revoke its own assignment relationship without disabling the person's identity elsewhere.
2. At job acceptance, an owner-operator picks or confirms the exact company context. Server authorizes active membership for `(driverId, companyId, dispatchId)` and binds each job, ticket, audit entry, and shift authority to that company. No foreign company's records may be included in a query or result.
3. Company rosters may include external contacts with no WB Mobile login. An existing verified driver account can be linked only by explicit verified identity/consent; same phone or similar name is not sufficient.
4. External-only contractors can receive separate, limited, expiring job links. Guest acknowledgements are NOT official tickets or WB-M execution. One shared job/dispatch identifier, two delivery channels depending on recipient identity.
5. A full-suite hauling company may explicitly enable temporary outside drivers without adding the Independent Dispatch job package. Independent Dispatch subscribers may also have regular WB Mobile drivers.
6. Migration requires reviewing shift authority, offline packets, HOS, billing and payroll attribution, invitations, and account/role security. All existing single-company records retain their meaning; no automatic migration or production rollout.
