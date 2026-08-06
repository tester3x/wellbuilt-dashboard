/**
 * CANONICAL protected root-key set for companies/{companyId} (vc51.9A6-A).
 *
 * SINGLE SOURCE OF TRUTH — the rules file must contain exactly this list
 * (test-rulesSourcePins.mjs asserts literal equality against
 * firestore.rules), and every emulator matrix case derives from it. Do
 * not copy these names anywhere else.
 *
 * Derived from @wellbuilt/contracts v1 (wellbuilt-contracts/src/types.ts)
 * and the proposed Firestore mapping for the contract layer:
 *
 *   companies/{companyId}.entitlement              ← CompanyEntitlement
 *     { contractVersion, companyId, planId, overrides[], effectiveFrom }
 *   companies/{companyId}.workPeriodConfiguration  ← CompanyWorkPeriodConfiguration
 *     { contractVersion, configurationVersion, mode, timezone,
 *       startLocalTime, durationMinutes }
 *   companies/{companyId}.effectiveCapabilities    ← EffectiveCompanyCapabilities
 *     (computed materialization — never customer-writable)
 *
 * The flattened variants (planId, workPeriodMode, configurationVersion,
 * contractVersion, entitlementOverrides, contractEnforced) are protected
 * DEFENSIVELY: whichever shape Part B finally writes via Admin SDK
 * callables, no ordinary client may pre-seed, alter, null, or erase any
 * spelling of the contract state. Protecting the superset costs nothing —
 * the 2026-08-06 writer census proved no legacy writer touches any of
 * these keys.
 *
 * Admin-side collections pinned alongside (deny-all to direct clients):
 *   platform_admins/{uid}         — server-owned admin records
 *   plans/{planId}                — plan catalog (callable-mediated later)
 *   platform_admin_audit/{id}     — proposed audit collection name for
 *                                   Part B admin callables (Admin SDK only)
 */

export const PROTECTED_COMPANY_KEYS = Object.freeze([
  'contractVersion',
  'planId',
  'entitlement',
  'entitlementOverrides',
  'workPeriodMode',
  'workPeriodConfiguration',
  'effectiveCapabilities',
  'configurationVersion',
  'contractEnforced',
]);

export const PLATFORM_ADMINS_COLLECTION = 'platform_admins';
export const PLANS_COLLECTION = 'plans';
export const ADMIN_AUDIT_COLLECTION = 'platform_admin_audit';
