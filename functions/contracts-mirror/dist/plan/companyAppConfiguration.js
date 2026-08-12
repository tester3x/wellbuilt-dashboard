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
import { isCoreApp, isWellbuiltAppKey, resolveAppEntitlement, } from './appEntitlement.js';
import { CONTRACT_VERSION } from '../types.js';
/** The only keys a configuration entry may carry. */
export const COMPANY_APP_CONFIGURATION_KEYS = Object.freeze([
    'enabled',
    'requiresActiveShift',
]);
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/**
 * Validate a raw company app-configuration field.
 *
 * Same discipline as plan entitlements, deliberately: `undefined` is
 * absence, `null` is a value somebody wrote and is malformed, and aliases
 * are refused so stored data uses canonical keys only. Suite is rejected
 * outright rather than accepted-and-ignored, so no company document can
 * claim an authority the architecture will not honour.
 */
export function validateCompanyAppConfigurations(value) {
    if (value === undefined)
        return { ok: true, present: false };
    if (!isPlainObject(value))
        return { ok: false, rejection: 'malformed_configuration_map' };
    const out = {};
    for (const key of Object.keys(value)) {
        if (!isWellbuiltAppKey(key))
            return { ok: false, rejection: 'unknown_app', key };
        if (isCoreApp(key))
            return { ok: false, rejection: 'core_app_not_configurable', key };
        const entry = value[key];
        if (!isPlainObject(entry)) {
            return { ok: false, rejection: 'malformed_configuration_entry', key };
        }
        for (const k of Object.keys(entry)) {
            if (!COMPANY_APP_CONFIGURATION_KEYS.includes(k)) {
                return { ok: false, rejection: 'malformed_configuration_entry', key };
            }
        }
        const enabled = entry.enabled;
        const shift = entry.requiresActiveShift;
        if (enabled !== undefined && typeof enabled !== 'boolean') {
            return { ok: false, rejection: 'malformed_configuration_entry', key };
        }
        if (shift !== undefined && typeof shift !== 'boolean') {
            return { ok: false, rejection: 'malformed_configuration_entry', key };
        }
        // Mirrors the plan-side shift_requirement_on_excluded_app rule. A
        // shift condition on something this company has switched off is
        // contradictory and would read as "partially enabled" to a human.
        if (enabled === false && shift === true) {
            return { ok: false, rejection: 'shift_requirement_on_disabled_app', key };
        }
        // NORMALIZATION: only the narrowing values survive. `enabled: true`
        // and `requiresActiveShift: false` are the defaults and state
        // nothing, so they are dropped rather than stored as a claim that
        // configuration granted access or removed a gate.
        const normalized = {};
        if (enabled === false)
            normalized.enabled = false;
        if (shift === true)
            normalized.requiresActiveShift = true;
        out[key] = normalized;
    }
    return { ok: true, present: true, value: out };
}
/** True when this company adds a shift requirement of its own. */
export function configurationRequiresActiveShift(config, app) {
    return config?.[app]?.requiresActiveShift === true;
}
/** True when this company has switched an app off operationally. */
export function configurationDisablesApp(config, app) {
    return config?.[app]?.enabled === false;
}
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
export function decideAppAccessWithConfiguration(plan, configuration, app, state) {
    const resolution = resolveAppEntitlement(plan, app);
    const base = {
        contractVersion: CONTRACT_VERSION,
        planId: resolution.planId,
        app,
        outcome: resolution.outcome,
    };
    // Core first, exactly as the plan-only path does. Suite must survive a
    // corrupt company configuration for the same reason it survives a
    // corrupt plan: it is where the resulting denial is explained.
    if (isCoreApp(app)) {
        return { ...base, access: 'allowed', reason: 'core_app_always_included' };
    }
    // The plan is the ceiling. Configuration is consulted only after the
    // commercial answer, and can never raise it.
    if (resolution.outcome === 'EXCLUDED' || resolution.outcome === 'INVALID_ENTITLEMENT_DATA') {
        return { ...base, access: 'denied', reason: resolution.reason };
    }
    const validation = validateCompanyAppConfigurations(configuration);
    if (!validation.ok) {
        return { ...base, access: 'denied', reason: `configuration_${validation.rejection}` };
    }
    const config = validation.present ? validation.value : undefined;
    if (configurationDisablesApp(config, app)) {
        return { ...base, access: 'denied', reason: 'disabled_by_company_configuration' };
    }
    // OR, never AND: a plan-level gate cannot be configured away, and a
    // company-level gate applies even to a plan that states none — including
    // a LEGACY_UNCONFIGURED plan, because narrowing is always safe.
    const requiresShift = resolution.outcome === 'INCLUDED_REQUIRES_ACTIVE_SHIFT'
        || configurationRequiresActiveShift(config, app);
    if (requiresShift && !state.hasActiveShift) {
        return { ...base, access: 'shift_required', reason: 'app_requires_active_shift' };
    }
    if (resolution.outcome === 'LEGACY_UNCONFIGURED') {
        return { ...base, access: 'allowed', reason: 'legacy_unconfigured_preserves_current_behavior' };
    }
    return { ...base, access: 'allowed', reason: resolution.reason };
}
//# sourceMappingURL=companyAppConfiguration.js.map