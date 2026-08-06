/**
 * CANONICAL protected root-key set for companies/{companyId}
 * (vc51.9A6-B — Mike-approved nested mapping).
 *
 * SINGLE SOURCE OF TRUTH — test-rulesSourcePins.mjs asserts literal
 * equality against firestore.rules AND against the Functions-side list
 * in functions/src/admin/adminHandlers.ts, and every emulator matrix
 * case derives from it. Do not copy these names anywhere else.
 *
 * ONE active schema shape exists:
 *
 *   companies/{companyId}.wellbuiltContract = {
 *     contractVersion,          // @wellbuilt/contracts handshake
 *     configurationVersion,     // bumped by every protected mutation
 *     planId,                   // assigned plans/{planId}
 *     entitlementOverrides,     // audited, time-bounded grants
 *     workPeriodConfiguration,  // { mode, timezone?, startLocalTime?,
 *                               //   durationMinutes? } — versions live
 *                               //   at the contract root only
 *     contractEnforced,         // boolean activation flag
 *   }
 *
 * EffectiveCompanyCapabilities is NEVER persisted — computed by
 * functions/src/admin/effectiveCapabilities.ts from the exact company
 * contract + exact plans/{planId} + active overrides.
 *
 * The RESERVED keys below are the Part A flattened proposal, kept
 * permanently denied so a second active schema shape can never appear:
 * they are OBSOLETE AND UNUSABLE, rules-denied for clients and
 * callable-rejected server-side. No live data migration is assumed —
 * no live document carries any of these keys (Part A census).
 */

export const CANONICAL_PROTECTED_ROOT = 'wellbuiltContract';

export const RESERVED_COMPANY_KEYS = Object.freeze([
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

/** Canonical root FIRST, then the reserved/deprecated names. */
export const PROTECTED_COMPANY_KEYS = Object.freeze([
  CANONICAL_PROTECTED_ROOT,
  ...RESERVED_COMPANY_KEYS,
]);

export const PLATFORM_ADMINS_COLLECTION = 'platform_admins';
export const PLANS_COLLECTION = 'plans';
export const ADMIN_AUDIT_COLLECTION = 'platform_admin_audit';
