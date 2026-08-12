/**
 * Per-app commercial entitlement (vc51.9L, additive).
 *
 * Answers exactly two questions, for one app, from the company's plan:
 *   1. Is this app INCLUDED in what the company bought?
 *   2. If included, does reaching it REQUIRE an active shift?
 *
 * WHAT THIS IS NOT. `requiresActiveShift` is a COMMERCIAL statement — this
 * app is sold as shift-scoped access — and nothing else. It is not DVIR,
 * JSA, Pre-Trip, Post-Trip, or any other per-shift completion requirement;
 * those are readiness gates that live in their own protocols and run AFTER
 * this one says the driver may reach the app at all. It is also not the
 * live shift: whether a shift is actually open is resolved by
 * `resolveWorkPeriod` and passed in here as a plain boolean.
 *
 * The three concerns this package exists to keep apart stay apart:
 *   COMMERCIAL entitlement  — what the company's plan includes (HERE).
 *   CUSTOMER configuration  — how included functionality behaves (elsewhere,
 *                             and it can never re-enable an excluded app).
 *   CURRENT shift state     — what this driver has open right now (the
 *                             work-period resolver; injected, never read).
 *
 * ONLY A GENUINELY ABSENT FIELD IS LEGACY. Present-but-malformed data —
 * `null`, an array, a scalar, an unknown key, a broken entry — is INVALID
 * and fails closed. It must never fall back to the permissive legacy path,
 * because that would let corrupt or truncated data silently restore access
 * a plan does not grant. Administrative rollback to legacy behavior is
 * DELETION of the field, never a stored `null`.
 *
 * NO INFERENCE FROM PLAN SHAPE. This module never reads `capabilities`,
 * never reads a tier label, and never derives an entitlement from either.
 * Paid functionality is granted only by an explicitly written entitlement,
 * so a free or owner-operator plan cannot silently acquire it.
 *
 * Pure and node-testable: no imports beyond types, no platform APIs, no
 * clock, no I/O.
 */
import type { ContractVersion } from '../types.js';
/**
 * The entitlement key space is the SSO AUDIENCE namespace, extended with
 * the same convention for apps that do not yet have an audience.
 *
 * Tickets and eQuipment are the audience strings verbatim — a test pins
 * that identity, so the two can never drift into separate names. Mobile,
 * JSA, and Dashboard are the ids Suite's app registry already uses; Suite
 * is the deep-link scheme it already answers on. Nothing here is a new
 * name for an app that already had one.
 */
export declare const WELLBUILT_APP_TICKETS: "wellbuilt-tickets";
export declare const WELLBUILT_APP_EQUIPMENT: "wellbuilt-equipment";
export declare const WELLBUILT_APP_JSA: "wellbuilt-jsa";
export declare const WELLBUILT_APP_MOBILE: "wellbuilt-mobile";
export declare const WELLBUILT_APP_SUITE: "wellbuilt-suite";
export declare const WELLBUILT_APP_DASHBOARD: "wellbuilt-dashboard";
export type WellbuiltAppKey = typeof WELLBUILT_APP_TICKETS | typeof WELLBUILT_APP_EQUIPMENT | typeof WELLBUILT_APP_JSA | typeof WELLBUILT_APP_MOBILE | typeof WELLBUILT_APP_SUITE | typeof WELLBUILT_APP_DASHBOARD;
export declare const WELLBUILT_APP_KEYS: readonly WellbuiltAppKey[];
export declare function isWellbuiltAppKey(v: unknown): v is WellbuiltAppKey;
/**
 * CORE apps are structural, not commercial: they are never sold, never
 * excludable, and never shift-gated.
 *
 * Suite is the authentication and coordination hub. It is where a plan
 * denial is explained, where a required shift is started, and where a
 * driver recovers access when something is wrong. Gating it on the very
 * data that might be missing or corrupt would strand the driver with no
 * surface on which to fix anything — the entitlement system would fail
 * into a state that cannot report its own failure.
 *
 * This buys Suite and NOTHING else. Core status is per-app, so a driver
 * who reaches Suite with an absent, empty, or malformed map still gets
 * WB-T, eQuipment, JSA, Mobile, and Dashboard resolved strictly on their
 * own entitlement — legacy, excluded, or invalid as the data dictates.
 */
export type WellbuiltCoreAppKey = typeof WELLBUILT_APP_SUITE;
export declare const WELLBUILT_CORE_APPS: readonly WellbuiltCoreAppKey[];
/**
 * Narrows to the CORE subtype, not to `WellbuiltAppKey`. That is what lets
 * the compiler prove the remaining branch handles exactly the destination
 * apps — a predicate as wide as the input would collapse the else-branch
 * to `never` and silently defeat the check.
 */
export declare function isCoreApp(app: unknown): app is WellbuiltCoreAppKey;
/**
 * Pre-existing LOCAL ids, mapped to the canonical key.
 *
 * Three id namespaces for the same five apps already exist in the field
 * (Suite's card registry, Suite's app switcher, and the SSO session app
 * claim). This map exists so consumers converge on the canonical key
 * instead of a fourth namespace being invented at each call site. It is a
 * READ-SIDE convenience only: stored entitlement maps must use canonical
 * keys, and `validatePlanAppEntitlements` rejects an alias outright.
 */
export declare const WELLBUILT_APP_KEY_ALIASES: Readonly<Record<string, WellbuiltAppKey>>;
/** Canonical key for a canonical key or a known local alias; else null. */
export declare function resolveWellbuiltAppKey(raw: unknown): WellbuiltAppKey | null;
/**
 * One app's commercial entitlement.
 *
 * `requiresActiveShift` is meaningful only when `included` is true, and is
 * omitted (not `false`) when the app carries no shift condition, so a plan
 * document says only what was actually decided.
 *
 * Deliberately carries NO cache age, TTL, freshness, or expiry field.
 * Offline cache validity is a client/session concern; a company does not
 * purchase a cache lifetime, and putting one here would make a commercial
 * record the authority on device behavior.
 */
export interface AppEntitlement {
    included: boolean;
    requiresActiveShift?: boolean;
}
/** Per-app entitlements carried by a plan. Absent ≠ empty ≠ malformed. */
export type PlanAppEntitlements = {
    [K in WellbuiltAppKey]?: AppEntitlement;
};
/** The only keys an entitlement entry may carry. */
export declare const APP_ENTITLEMENT_KEYS: readonly string[];
export type AppEntitlementOutcome = 
/** The plan predates per-app entitlement. Callers preserve today's behavior. */
'LEGACY_UNCONFIGURED'
/** Included, reachable without an open shift. */
 | 'INCLUDED_NO_SHIFT_REQUIRED'
/** Included, but reaching it requires an active shift. */
 | 'INCLUDED_REQUIRES_ACTIVE_SHIFT'
/** Not part of the plan. Customer configuration cannot re-enable it. */
 | 'EXCLUDED'
/** Present but unusable data. Fails closed — never legacy, never allowed. */
 | 'INVALID_ENTITLEMENT_DATA';
export interface AppEntitlementResolution {
    contractVersion: ContractVersion;
    planId: string;
    app: WellbuiltAppKey;
    outcome: AppEntitlementOutcome;
    /** Stable machine reason. Never a sentence to show a user. */
    reason: string;
}
/**
 * The slice of a plan this module reads.
 *
 * `apps` is typed `unknown` ON PURPOSE: these helpers accept RAW plan data
 * straight from a document, a cache, or a callable payload, and validate it
 * themselves. A caller cannot satisfy the type by asserting that corrupt
 * data is well-formed. `PlanDefinition` stays strictly typed for WRITERS.
 */
export type AppEntitlementPlanView = Readonly<{
    planId: string;
    apps?: unknown;
}>;
/**
 * Resolve one app against one plan. Safe on unvalidated input.
 *
 * ABSENT vs EMPTY vs MALFORMED is the whole migration story:
 *   `apps` property absent → LEGACY_UNCONFIGURED for every non-core app.
 *                            The plan has not been migrated; behavior is
 *                            unchanged. A property whose value is
 *                            `undefined` is absent by ordinary JavaScript
 *                            semantics and serializes away entirely.
 *   `apps` valid map       → AUTHORITATIVE. An app missing from a present
 *                            map is EXCLUDED, which is why `{}` means
 *                            "this plan includes no apps" and is never
 *                            mistaken for "not yet configured".
 *   `apps` present but bad → INVALID_ENTITLEMENT_DATA. `null`, arrays,
 *                            scalars, unknown keys, and broken entries all
 *                            fail closed. Rolling a plan back to legacy is
 *                            DELETING the field, not storing `null`.
 */
export declare function resolveAppEntitlement(plan: AppEntitlementPlanView, app: WellbuiltAppKey): AppEntitlementResolution;
/**
 * True when the plan permits reaching the app at all, shift aside.
 *
 * LEGACY_UNCONFIGURED counts as entitled ON PURPOSE and TEMPORARILY: an
 * unmigrated plan must behave exactly as it does today. It is a distinct
 * outcome precisely so a caller can log or report the unmigrated state
 * rather than have it disappear into a boolean. INVALID_ENTITLEMENT_DATA
 * does NOT count as entitled — that is the whole point of separating them.
 */
export declare function isAppEntitled(r: AppEntitlementResolution): boolean;
/** True only for the explicit shift-scoped entitlement. */
export declare function appRequiresActiveShift(r: AppEntitlementResolution): boolean;
export type AppAccessDecision = {
    contractVersion: ContractVersion;
    planId: string;
    app: WellbuiltAppKey;
    outcome: AppEntitlementOutcome;
    access: 'allowed' | 'shift_required' | 'denied';
    reason: string;
};
/**
 * Compose entitlement with the CURRENT shift state.
 *
 * `hasActiveShift` is supplied by the caller from
 * `isOperationallyOpen(resolveWorkPeriod(...))`. This module deliberately
 * does not resolve a period itself: one shift authority, consumed here.
 *
 * Fails closed: only LEGACY, INCLUDED_NO_SHIFT_REQUIRED, a satisfied
 * INCLUDED_REQUIRES_ACTIVE_SHIFT, or a core app can produce 'allowed'.
 */
export declare function decideAppAccess(plan: AppEntitlementPlanView, app: WellbuiltAppKey, state: {
    hasActiveShift: boolean;
}): AppAccessDecision;
export declare const APP_CONFIGURATION_CONFLICT: "configuration_conflicts_with_app_entitlement";
/**
 * Entitlement beats configuration, in that direction only.
 *
 * Mirrors the existing `configuration_conflicts_with_entitlement` verdict
 * the work-period resolver already returns. A customer may turn an
 * INCLUDED app off; a customer may never turn an EXCLUDED app on, and the
 * attempt is reported as a conflict rather than silently ignored.
 * Malformed data yields no effective enablement either — it is not a
 * configuration conflict, so it is reported through the resolution.
 */
export declare function reconcileAppConfiguration(plan: AppEntitlementPlanView, app: WellbuiltAppKey, configuredEnabled: boolean): {
    effective: boolean;
    conflict: typeof APP_CONFIGURATION_CONFLICT | null;
};
export type AppEntitlementRejection = 'malformed_entitlement_map' | 'unknown_app' | 'malformed_entitlement_entry' | 'shift_requirement_on_excluded_app' | 'core_app_not_excludable' | 'shift_requirement_on_core_app';
export type PlanAppEntitlementsValidation = 
/** Property genuinely absent: the plan is unmigrated. */
{
    ok: true;
    present: false;
}
/** Field present and well-formed — including the authoritative `{}`. */
 | {
    ok: true;
    present: true;
    value: PlanAppEntitlements;
} | {
    ok: false;
    rejection: AppEntitlementRejection;
    key?: string;
};
/**
 * Validate a raw `apps` field before it is stored or trusted.
 *
 * `undefined` is absence — the ordinary JavaScript reading of an omitted
 * optional property, and the one that survives serialization as a genuinely
 * missing key. `null` is NOT absence: it is a value someone wrote, it does
 * not describe any entitlement, and accepting it as legacy would let a bad
 * write hand back permissive access. Rollback is field deletion.
 *
 * Aliases are NOT accepted here: a stored plan must use canonical keys, so
 * an alias reaching persistence is `unknown_app`. `resolveWellbuiltAppKey`
 * remains available for reading ids that come from a UI or a claim.
 *
 * A map that OMITS a core app is fine — core access does not depend on the
 * data. A map that tries to EXCLUDE or shift-gate one is rejected, so no
 * plan document can claim something the architecture will not honor.
 */
export declare function validatePlanAppEntitlements(value: unknown): PlanAppEntitlementsValidation;
//# sourceMappingURL=appEntitlement.d.ts.map