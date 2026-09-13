# Phase 5B — Corrected Security Contract for the Tenant-Scoped Company-Update Callable

Status: **DESIGN ONLY.** No Functions/rules edits until the exact post-Watchdog live Functions baseline is supplied. Corrects the Phase 5A-proposed contract per review. Verified against the live client model (`src/lib/auth.ts`) and the deployed caller resolver (`functions/src/security/adminAuth.ts`) at Dashboard `607fd2a1`.

## 0. Verified facts this contract depends on
- **Exact capability identifiers (from `auth.ts` Capability union):** `manageCompany`, `editBilling`, `manageRolesAndCapabilities`, `manageDrivers`, `approvePayroll`, `manageWells`, `manageRoutes`, `manageSafety`, `manageEquipment`. The role/capability editor identifier is **`manageRolesAndCapabilities`** — NOT `manageRoles`. Use the verified string.
- **`adminUpdateCompanySafe` is platform-admin only** (proven Phase 5A: `wellbuiltAdmin` claim + enabled `platform_admins/{uid}` record). It must NOT be reused for tenant admins.
- **Pre-existing server-authz weakness to fix (do not carry forward):** `loadDashboardCaller` computes `caps` via `resolveCaps(roles, overrides)` where `overrides = companies/{companyId}.roleCapabilities` (adminHandlers/adminAuth). That field is **client-writable** (not in `PROTECTED_COMPANY_KEYS`, permissive rules) and `roles`/`companyId` come from RTDB `users/{uid}` (open under current `database.rules.json`). Authorizing a mutation off this chain is escalatable. Phase 5B authorization must NOT trust it.

## 1. Caller identity — server-derived, never client-supplied
- **companyId:** derived from the caller's **canonical server-side identity**, preferentially a **protected Firebase Auth custom claim** (`token.companyId`) set only by a server process; never from `request.data`, never from a client-writable store. The payload MUST NOT contain a `companyId` field; if present, reject (`invalid-argument: companyId_not_accepted`).
- **Rejection of client scope:** the callable operates ONLY on the caller's own company. There is no parameter to target another company (that path stays platform-admin `adminUpdateCompanySafe`).

## 2. Authorization — from protected data only
- Resolve the caller's **roles and capabilities from protected, server-authoritative sources** (custom claims and/or a server-owned, client-unwritable identity record). **Do NOT** derive authorization from `companies/{id}.roleCapabilities` or any other company-document field, because those remain directly writable under current rules.
- Until identity/claims + rules are hardened so `users/{uid}` and `roleCapabilities` are not self-writable, the callable must treat only the protected claim set as authoritative for the authorization decision. (Hardening `loadDashboardCaller` + RTDB `users` rules + making `roleCapabilities` writable only through the governed role endpoint is part of this phase's Functions/rules work.)
- Capability → allowed operation mapping (deny by default):
  - **`manageCompany`** → general company config fields (§3a).
  - **`editBilling`** → billing/fuel config fields (§3b).
  - **`manageRolesAndCapabilities`** → role/label/capability changes ONLY, via the separate role endpoint (§4) with anti-escalation — NOT via the generic field-merge.
- A caller lacking the mapped capability for a requested field set is rejected `permission-denied` before any write.

## 3. Field allowlist (per capability; deny-by-default; `PROTECTED_COMPANY_KEYS` always forbidden)
Payload shape mirrors the platform callable minus companyId: `{ fields: { ... } }`, 1..30 keys, each defined, no dotted paths, no `__` prefix. Every key must be in the allowlist for the caller's capability, else reject `permission-denied: field_not_allowed:<k>`.

- **3a. `manageCompany` allowlist:** company profile (`name,address,city,state,zip,phone,notes`), operations toggles (`splitTickets,transferRequiresApproval,liveDispatchSync,invoicingMode,cancelledNumberHandling,wellMonitoring`), photos (`requirePhotos,minPhotoCount,photoRetentionDays`), `packages/activePackages`, `customJobTypes`, invoice config (`invoicePrefix,ticketPrefix,invoiceBook`), `levelReport*`, `assignedOperators`, `ticketTemplates`, `branding` (logoUrl/thermalLogoUrl/primaryColor), `jsa*` policy fields.
- **3b. `editBilling` allowlist:** `billingConfig`, `rateSheets`, `payConfig`, `doeRegion`, `currentDieselPrice`.
- **NEVER via this callable:** `roleLabels`, `roleCapabilities` (see §4); every `PROTECTED_COMPANY_KEYS` entry (`wellbuiltContract, contractVersion, planId, entitlement, entitlementOverrides, workPeriodMode, workPeriodConfiguration, effectiveCapabilities, configurationVersion, contractEnforced`); anything owned by the WorkPeriod/contract authority path (§6).

## 4. Role / capability mutation — SEPARATE endpoint, explicit anti-escalation
`roleLabels`/`roleCapabilities` are NOT eligible for the generic field-merge. A dedicated governed operation gated by `manageRolesAndCapabilities` handles them, with hard anti-escalation invariants enforced server-side against the actor's **protected** capability set:
1. **No self/other escalation beyond own authority:** a role's resulting capability set may not include any capability the acting caller does not themselves hold (protected-source caps). Reject `permission-denied: escalation_denied:<cap>`.
2. **No platform-admin creation:** may never set/imply `wellbuiltAdmin`, platform-admin membership, `viewAllCompanies`, `viewTruthDebug`, `viewDiagnostics`, or any platform-scoped capability. Reject.
3. **No protected-capability grants:** `manageRolesAndCapabilities` itself, and identity-lane capabilities (`manageDrivers` and any driver-identity control), require explicit, separately-audited authority — not grantable by a tenant admin to elevate reach.
4. **Own-company only** (§1); **audited** with actor + before/after capability diff.
5. Validate the entire resulting `roleCapabilities` map (all roles), not just the changed entry, so a smuggled grant elsewhere is caught.

## 5. Behavior, result, errors, audit (mirror the proven platform contract)
- Transaction: company must exist → field-merge (or role-map update) → **audit** with `operation`, `actorUid`, `companyId`, `changedFields`/capability diff.
- **Success:** `{ companyId, changedFields }` (companyId echoed from server identity, not input).
- **Errors (HttpsError code + adminCode):** `unauthenticated`; `permission-denied` (`missing_capability`, `field_not_allowed:*`, `protected_field:*`, `escalation_denied:*`, `cross_company`); `invalid-argument` (`companyId_not_accepted`, `fields_not_object`, `fields_empty_or_unbounded`, `invalid_field_name:*`, `undefined_value:*`); `not-found` (`company_not_found`).

## 6. Preserve existing authority paths (do not absorb)
- **PROTECTED_COMPANY_KEYS** stay forbidden on every path.
- **WorkPeriod / WellBuilt contract** remain governed exclusively by their existing dedicated callables (`adminSetCompanyWorkPeriodConfiguration`, `adminAssignCompanyPlan`, `adminAddEntitlementOverride`, `adminRemoveEntitlementOverride`, `adminSetCompanyContractEnforcement`, `adminSetCompanyAppConfiguration`) with their VerifiedAdminGate/platform authority. The tenant callable must not touch contract/entitlement/workPeriod state.
- Platform-admin cross-company edits stay on `adminUpdateCompanySafe`.

## 7. Tier RTDB driver-sync — make it a governed atomic server op
The Phase 5A Tier migration governs only the `companies/{id}.tier` write; the follow-on RTDB `drivers/approved/*/tier` fan-out remains a **non-blocking client side effect and is NOT atomic** with it. Move that sync into a governed server operation (either the tenant/platform company-update path computing the driver fan-out server-side within one transaction/batch, or a dedicated `...SetCompanyTier` callable) so tier + driver mirror commit together. Driver writes are identity-lane — coordinate with that lane.

## 8. Client migration (after the callable ships + is emulator-proven)
Route every INCOMPATIBLE tenant control from the Phase 5A audit (all Settings config cards, RequiredPhotoSpecs, Roles, Billing DOE Region, tenant Save-Company path) through the new tenant callable via the established caller-class helper pattern; remove the direct-write path (no fallback); add runtime payload tests + unauthorized-return tests; then tighten Firestore/RTDB/Storage rules to deny direct client `companies/{id}` writes. Only after rules are tightened AND emulator-proven does the classification move from `GOVERNED DASHBOARD PATH / RULES BYPASS STILL OPEN` to `WORKING`.

## 9. Sequencing / lane
No Functions or rules edits until the exact post-Watchdog live Functions baseline is supplied and the Watchdog operation is conclusively completed or parked. This document is the contract to implement against at that point.
