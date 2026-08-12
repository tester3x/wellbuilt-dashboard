import { CONTRACT_VERSION } from '../types.js';
// ── canonical app keys ────────────────────────────────────────────────────
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
export const WELLBUILT_APP_TICKETS = 'wellbuilt-tickets';
export const WELLBUILT_APP_EQUIPMENT = 'wellbuilt-equipment';
export const WELLBUILT_APP_JSA = 'wellbuilt-jsa';
export const WELLBUILT_APP_MOBILE = 'wellbuilt-mobile';
export const WELLBUILT_APP_SUITE = 'wellbuilt-suite';
export const WELLBUILT_APP_DASHBOARD = 'wellbuilt-dashboard';
export const WELLBUILT_APP_KEYS = Object.freeze([
    WELLBUILT_APP_TICKETS,
    WELLBUILT_APP_EQUIPMENT,
    WELLBUILT_APP_JSA,
    WELLBUILT_APP_MOBILE,
    WELLBUILT_APP_SUITE,
    WELLBUILT_APP_DASHBOARD,
]);
export function isWellbuiltAppKey(v) {
    return typeof v === 'string' && WELLBUILT_APP_KEYS.includes(v);
}
export const WELLBUILT_CORE_APPS = Object.freeze([
    WELLBUILT_APP_SUITE,
]);
/**
 * Narrows to the CORE subtype, not to `WellbuiltAppKey`. That is what lets
 * the compiler prove the remaining branch handles exactly the destination
 * apps — a predicate as wide as the input would collapse the else-branch
 * to `never` and silently defeat the check.
 */
export function isCoreApp(app) {
    return typeof app === 'string' && WELLBUILT_CORE_APPS.includes(app);
}
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
export const WELLBUILT_APP_KEY_ALIASES = Object.freeze({
    'water-ticket': WELLBUILT_APP_TICKETS, // Suite card registry id
    wbt: WELLBUILT_APP_TICKETS, // Suite switcher id / session app claim
    wbs: WELLBUILT_APP_SUITE,
    wbm: WELLBUILT_APP_MOBILE,
    wbjsa: WELLBUILT_APP_JSA,
    wbew: WELLBUILT_APP_EQUIPMENT,
    equipment: WELLBUILT_APP_EQUIPMENT, // session app claim
});
/** Canonical key for a canonical key or a known local alias; else null. */
export function resolveWellbuiltAppKey(raw) {
    if (typeof raw !== 'string')
        return null;
    if (isWellbuiltAppKey(raw))
        return raw;
    return Object.prototype.hasOwnProperty.call(WELLBUILT_APP_KEY_ALIASES, raw)
        ? WELLBUILT_APP_KEY_ALIASES[raw]
        : null;
}
/** The only keys an entitlement entry may carry. */
export const APP_ENTITLEMENT_KEYS = Object.freeze([
    'included',
    'requiresActiveShift',
]);
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
export function resolveAppEntitlement(plan, app) {
    const base = {
        contractVersion: CONTRACT_VERSION,
        planId: typeof plan?.planId === 'string' ? plan.planId : '',
        app,
    };
    // NO PLAN AT ALL is not an unmigrated plan. A legacy plan is an object
    // that simply lacks the `apps` property; `null`, `undefined`, or a
    // non-object is a failed load or a caller error, and must not inherit
    // the permissive legacy path — not even for a core app, because core
    // access describes entitlement data INSIDE a plan and is no substitute
    // for having one. Callers handle "plan unavailable" as its own state.
    if (!isPlainObject(plan)) {
        return { ...base, outcome: 'INVALID_ENTITLEMENT_DATA', reason: 'malformed_plan' };
    }
    // Core apps are decided before the entitlement data is consulted: Suite
    // must survive data that is absent, empty, corrupt, or actively hostile.
    if (isCoreApp(app)) {
        return { ...base, outcome: 'INCLUDED_NO_SHIFT_REQUIRED', reason: 'core_app_always_included' };
    }
    const validation = validatePlanAppEntitlements(plan?.apps);
    if (!validation.ok) {
        return { ...base, outcome: 'INVALID_ENTITLEMENT_DATA', reason: validation.rejection };
    }
    if (!validation.present) {
        return { ...base, outcome: 'LEGACY_UNCONFIGURED', reason: 'plan_has_no_app_entitlements' };
    }
    const entry = validation.value[app];
    if (entry === undefined) {
        return { ...base, outcome: 'EXCLUDED', reason: 'app_not_in_plan_entitlements' };
    }
    if (!entry.included) {
        return { ...base, outcome: 'EXCLUDED', reason: 'app_explicitly_excluded' };
    }
    return entry.requiresActiveShift === true
        ? { ...base, outcome: 'INCLUDED_REQUIRES_ACTIVE_SHIFT', reason: 'app_included_requires_active_shift' }
        : { ...base, outcome: 'INCLUDED_NO_SHIFT_REQUIRED', reason: 'app_included' };
}
/**
 * True when the plan permits reaching the app at all, shift aside.
 *
 * LEGACY_UNCONFIGURED counts as entitled ON PURPOSE and TEMPORARILY: an
 * unmigrated plan must behave exactly as it does today. It is a distinct
 * outcome precisely so a caller can log or report the unmigrated state
 * rather than have it disappear into a boolean. INVALID_ENTITLEMENT_DATA
 * does NOT count as entitled — that is the whole point of separating them.
 */
export function isAppEntitled(r) {
    return r.outcome !== 'EXCLUDED' && r.outcome !== 'INVALID_ENTITLEMENT_DATA';
}
/** True only for the explicit shift-scoped entitlement. */
export function appRequiresActiveShift(r) {
    return r.outcome === 'INCLUDED_REQUIRES_ACTIVE_SHIFT';
}
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
export function decideAppAccess(plan, app, state) {
    const r = resolveAppEntitlement(plan, app);
    const base = {
        contractVersion: r.contractVersion,
        planId: r.planId,
        app: r.app,
        outcome: r.outcome,
    };
    switch (r.outcome) {
        case 'EXCLUDED':
        case 'INVALID_ENTITLEMENT_DATA':
            return { ...base, access: 'denied', reason: r.reason };
        case 'LEGACY_UNCONFIGURED':
            return { ...base, access: 'allowed', reason: 'legacy_unconfigured_preserves_current_behavior' };
        case 'INCLUDED_REQUIRES_ACTIVE_SHIFT':
            return state.hasActiveShift
                ? { ...base, access: 'allowed', reason: r.reason }
                : { ...base, access: 'shift_required', reason: 'app_requires_active_shift' };
        case 'INCLUDED_NO_SHIFT_REQUIRED':
            return { ...base, access: 'allowed', reason: r.reason };
        default:
            // Unreachable for the closed set above; an outcome added without a
            // decision must deny rather than inherit permission by omission.
            return { ...base, access: 'denied', reason: 'unhandled_entitlement_outcome' };
    }
}
// ── customer configuration reconciliation ─────────────────────────────────
export const APP_CONFIGURATION_CONFLICT = 'configuration_conflicts_with_app_entitlement';
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
export function reconcileAppConfiguration(plan, app, configuredEnabled) {
    const r = resolveAppEntitlement(plan, app);
    if (r.outcome === 'EXCLUDED') {
        return { effective: false, conflict: configuredEnabled ? APP_CONFIGURATION_CONFLICT : null };
    }
    if (r.outcome === 'INVALID_ENTITLEMENT_DATA') {
        return { effective: false, conflict: null };
    }
    return { effective: configuredEnabled, conflict: null };
}
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
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
export function validatePlanAppEntitlements(value) {
    if (value === undefined)
        return { ok: true, present: false };
    if (!isPlainObject(value))
        return { ok: false, rejection: 'malformed_entitlement_map' };
    const out = {};
    for (const key of Object.keys(value)) {
        if (!isWellbuiltAppKey(key))
            return { ok: false, rejection: 'unknown_app', key };
        const entry = value[key];
        if (!isPlainObject(entry)) {
            return { ok: false, rejection: 'malformed_entitlement_entry', key };
        }
        for (const k of Object.keys(entry)) {
            if (!APP_ENTITLEMENT_KEYS.includes(k)) {
                return { ok: false, rejection: 'malformed_entitlement_entry', key };
            }
        }
        if (typeof entry.included !== 'boolean') {
            return { ok: false, rejection: 'malformed_entitlement_entry', key };
        }
        const shift = entry.requiresActiveShift;
        if (shift !== undefined && typeof shift !== 'boolean') {
            return { ok: false, rejection: 'malformed_entitlement_entry', key };
        }
        if (isCoreApp(key)) {
            // Suite is not a product line. A plan may state `{included:true}`
            // redundantly, but may not sell it, withhold it, or shift-gate it.
            if (entry.included === false)
                return { ok: false, rejection: 'core_app_not_excludable', key };
            if (shift === true)
                return { ok: false, rejection: 'shift_requirement_on_core_app', key };
        }
        if (entry.included === false && shift === true) {
            // A shift condition on something the company cannot reach at all is
            // contradictory, and would read as "partially included" to a human.
            return { ok: false, rejection: 'shift_requirement_on_excluded_app', key };
        }
        const normalized = { included: entry.included };
        if (shift === true)
            normalized.requiresActiveShift = true;
        out[key] = normalized;
    }
    return { ok: true, present: true, value: out };
}
/** Compile-time proof that a written plan satisfies the read-side view. */
const _planIsReadable = (p) => p;
void _planIsReadable;
//# sourceMappingURL=appEntitlement.js.map