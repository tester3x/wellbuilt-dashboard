/**
 * Per-company operational app configuration (vc51.9M, additive).
 *
 * The plan says WHAT A COMPANY BOUGHT. This says HOW THAT COMPANY RUNS
 * what it bought. Two companies can share one commercial plan and still
 * operate it differently — which is the whole reason this exists: a
 * shift requirement written into a shared plan is imposed on every
 * company assigned to it, and that is a commercial statement, not an
 * operational one.
 *
 * NARROWING ONLY, IN ONE DIRECTION. Configuration may switch an included
 * app off, and may ADD a shift requirement to an app the plan includes.
 * It may never enable an app the plan excludes or omits, and it may never
 * remove a shift requirement the plan states. So:
 *
 *   effective included   = plan.included AND config.enabled !== false
 *   effective shift gate = plan.requiresActiveShift OR config.requiresActiveShift
 *
 * That OR is what makes a migration safe: while a requirement is being
 * moved from a plan to a company, it is satisfied by at least one source
 * at every instant, so no window opens where access silently widens.
 *
 * NOT READINESS. `requiresActiveShift` here still means "reaching this
 * app requires an open shift" and nothing more. DVIR, JSA, Pre-Trip and
 * Post-Trip remain separate gates that run after this one.
 *
 * Every 0.3.0 export is untouched — `decideAppAccess` still answers from
 * the plan alone, so an existing consumer's behaviour cannot shift under
 * it. Configuration-aware callers opt in explicitly.
 */
import { type AppAccessDecision, type AppEntitlementPlanView, type WellbuiltAppKey } from './appEntitlement.js';
/**
 * One app's operational configuration.
 *
 * Both fields are optional and both are NARROWING. `enabled` is absent or
 * true by default; only `false` changes anything. `requiresActiveShift`
 * is absent or false by default; only `true` changes anything. A stored
 * `enabled: true` or `requiresActiveShift: false` therefore states
 * nothing, and normalization drops it, so a configuration document can
 * never appear to say something it cannot do — in particular it can never
 * look like it is turning a plan-level gate off.
 */
export interface CompanyAppConfiguration {
    enabled?: boolean;
    requiresActiveShift?: boolean;
}
/** Per-app operational configuration. Absent ≠ empty ≠ malformed. */
export type CompanyAppConfigurations = {
    [K in WellbuiltAppKey]?: CompanyAppConfiguration;
};
/** The only keys a configuration entry may carry. */
export declare const COMPANY_APP_CONFIGURATION_KEYS: readonly string[];
export type CompanyAppConfigurationRejection = 'malformed_configuration_map' | 'unknown_app' | 'malformed_configuration_entry'
/** A shift condition on an app this company has switched off. */
 | 'shift_requirement_on_disabled_app'
/** Suite is structural. A company cannot switch it off or gate it. */
 | 'core_app_not_configurable';
export type CompanyAppConfigurationsValidation = 
/** Property genuinely absent: this company adds nothing. */
{
    ok: true;
    present: false;
}
/** Present and well-formed — including an authoritative `{}`. */
 | {
    ok: true;
    present: true;
    value: CompanyAppConfigurations;
} | {
    ok: false;
    rejection: CompanyAppConfigurationRejection;
    key?: string;
};
/**
 * Validate a raw company app-configuration field.
 *
 * Same discipline as plan entitlements, deliberately: `undefined` is
 * absence, `null` is a value somebody wrote and is malformed, and aliases
 * are refused so stored data uses canonical keys only. Suite is rejected
 * outright rather than accepted-and-ignored, so no company document can
 * claim an authority the architecture will not honour.
 */
export declare function validateCompanyAppConfigurations(value: unknown): CompanyAppConfigurationsValidation;
/** True when this company adds a shift requirement of its own. */
export declare function configurationRequiresActiveShift(config: CompanyAppConfigurations | undefined, app: WellbuiltAppKey): boolean;
/** True when this company has switched an app off operationally. */
export declare function configurationDisablesApp(config: CompanyAppConfigurations | undefined, app: WellbuiltAppKey): boolean;
/**
 * The decision `decideAppAccess` makes, refined by ONE company's
 * operational configuration.
 *
 * `decideAppAccess` is deliberately left alone: an existing caller must
 * keep getting the plan-only answer it was written against, so
 * configuration awareness is opt-in at the call site.
 *
 * `outcome` continues to describe the COMMERCIAL state — configuration
 * never changes what a company bought — while `access` and `reason`
 * describe the effective result. An app the plan includes and the company
 * has switched off is therefore reported as an included app that is
 * denied, not as an app the company never purchased.
 *
 * Fails closed: malformed configuration denies every destination app,
 * because unusable data must not be read as "this company narrows
 * nothing". Suite is decided before configuration is even consulted.
 */
export declare function decideAppAccessWithConfiguration(plan: AppEntitlementPlanView, configuration: unknown, app: WellbuiltAppKey, state: {
    hasActiveShift: boolean;
}): AppAccessDecision;
//# sourceMappingURL=companyAppConfiguration.d.ts.map