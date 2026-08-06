/**
 * @tester3x/wellbuilt-contracts — versioned schema (vc51.9A).
 *
 * Environment-neutral: no Firebase, no AsyncStorage, no React/Expo, no
 * network, no filesystem, no secrets. Every consumer (Dashboard, WB-T,
 * WB-JSA, WB-S) reads the SAME definitions so period and entitlement
 * semantics cannot drift between apps.
 *
 * Three concerns are deliberately separate and must never be conflated:
 *   1. COMMERCIAL entitlement — what the company bought (WellBuilt Admin).
 *   2. ROLE capabilities      — what a user inside the company may do
 *                               (pre-existing per-user system; NOT here).
 *   3. OPERATIONAL config     — how the company runs its work day
 *                               (customer-editable within entitlement).
 *
 * Tier labels ('free' | 'field' | 'god') are presentation only and MUST
 * NOT be used as application logic.
 */
/** Bumped when a breaking contract change ships. Consumers handshake. */
export const CONTRACT_VERSION = 1;
/**
 * Does this action require a verified work period for this company?
 * Ordinary app use never does. Shift-scoped operational actions do
 * whenever the company runs an explicit-shift lifecycle or a configured
 * period; a company with neither still performs no period-bound work.
 */
export function requiresWorkPeriod(caps, action) {
    if (action === 'app_use')
        return false;
    if (caps.workPeriodMode === 'explicit_shift')
        return caps.explicitShiftRequiredBeforeJobs;
    return true;
}
export function isOperationallyOpen(r) {
    return r.outcome === 'ACTIVE_EXPLICIT_SHIFT' || r.outcome === 'CURRENT_DERIVED_PERIOD';
}
/**
 * Request-bound completion (signing/filing/receipts) additionally requires
 * a POSITIVELY verified period: never an unverified or offline one.
 */
export function mayBindRequestEvidence(r) {
    return isOperationallyOpen(r);
}
/**
 * Build the binding for a new shift-scoped record. Returns a rejection
 * instead of a binding whenever the period is closed, missing, unverified,
 * or belongs to another company/driver — the same fail-closed rule that
 * governs JSA request evidence.
 */
export function bindShiftScopedRecord(kind, resolution, expected, nowMs) {
    if (resolution.contractVersion !== CONTRACT_VERSION) {
        return { ok: false, rejection: 'contract_version_mismatch' };
    }
    if (resolution.companyId !== expected.companyId)
        return { ok: false, rejection: 'company_mismatch' };
    if (resolution.driverId !== expected.driverId)
        return { ok: false, rejection: 'driver_mismatch' };
    if (resolution.outcome === 'UNVERIFIED_OFFLINE')
        return { ok: false, rejection: 'period_unverified' };
    if (!isOperationallyOpen(resolution))
        return { ok: false, rejection: 'period_not_open' };
    return {
        ok: true,
        binding: {
            contractVersion: CONTRACT_VERSION,
            kind,
            companyId: resolution.companyId,
            driverId: resolution.driverId,
            periodId: resolution.periodId,
            mode: resolution.mode,
            source: resolution.source,
            boundAtIso: new Date(nowMs).toISOString(),
        },
    };
}
/** Verify an existing record still matches the currently resolved period. */
export function verifyShiftScopedBinding(binding, resolution) {
    if (binding.contractVersion !== CONTRACT_VERSION)
        return { ok: false, rejection: 'contract_version_mismatch' };
    if (!isOperationallyOpen(resolution)) {
        return { ok: false, rejection: resolution.outcome === 'UNVERIFIED_OFFLINE' ? 'period_unverified' : 'period_not_open' };
    }
    if (binding.companyId !== resolution.companyId)
        return { ok: false, rejection: 'company_mismatch' };
    if (binding.driverId !== resolution.driverId)
        return { ok: false, rejection: 'driver_mismatch' };
    if (binding.periodId !== resolution.periodId)
        return { ok: false, rejection: 'period_mismatch' };
    return { ok: true };
}
//# sourceMappingURL=types.js.map