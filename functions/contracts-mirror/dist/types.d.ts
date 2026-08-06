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
export declare const CONTRACT_VERSION: 1;
export type ContractVersion = typeof CONTRACT_VERSION;
/** Capabilities a PLAN can grant. Distinct from per-user role capabilities. */
export type PlanCapability = 'jsa' | 'dvir' | 'explicitShiftLifecycle' | 'companyDefinedWorkPeriod' | 'dispatch' | 'billing';
export interface PlanDefinition {
    contractVersion: ContractVersion;
    planId: string;
    displayName: string;
    capabilities: PlanCapability[];
    status: 'active' | 'deprecated';
}
/** An audited, time-bounded grant beyond the assigned plan. */
export interface EntitlementOverride {
    capability: PlanCapability;
    granted: boolean;
    reason: string;
    /** WellBuilt admin identity — never a customer user. */
    grantedBy: string;
    grantedAt: string;
    expiresAt?: string | null;
}
export interface CompanyEntitlement {
    contractVersion: ContractVersion;
    companyId: string;
    planId: string;
    overrides?: EntitlementOverride[];
    effectiveFrom?: string;
}
/**
 * Operational actions the suite performs today. Only SOME require a
 * verified work period — suite login alone NEVER does.
 *
 * Liquid Gold proves why: WB-M testers and Mike are the SAME company.
 * WB-M testers authenticate and use WB-M only; Mike runs the explicit
 * shift lifecycle through WB-S/WB-T/WB-JSA/eQuipment. A company-level
 * work-period mode therefore describes how shift-scoped work is bounded —
 * it must never become a blanket Start Shift requirement at login.
 */
export type OperationalAction = 'app_use' | 'wbt_job_start' | 'jsa_request' | 'equipment_dvir';
/**
 * Does this action require a verified work period for this company?
 * Ordinary app use never does. Shift-scoped operational actions do
 * whenever the company runs an explicit-shift lifecycle or a configured
 * period; a company with neither still performs no period-bound work.
 */
export declare function requiresWorkPeriod(caps: Pick<EffectiveCompanyCapabilities, 'workPeriodMode' | 'explicitShiftRequiredBeforeJobs'>, action: OperationalAction): boolean;
/** How a company's work day is bounded. */
export type WorkPeriodMode = 'explicit_shift' | 'company_defined_period';
/**
 * Customer-editable operating configuration. Contains NO mutable current
 * shift state — the live shift is a separate authoritative lifecycle
 * record owned by WB-S.
 */
export interface CompanyWorkPeriodConfiguration {
    contractVersion: ContractVersion;
    configurationVersion: number;
    mode: WorkPeriodMode;
    /** IANA zone, e.g. 'America/Chicago'. Required for derived mode. */
    timezone?: string;
    /** 'HH:MM' local start boundary — derived mode only. */
    startLocalTime?: string;
    /** Period length in minutes (overnight allowed) — derived mode only. */
    durationMinutes?: number;
}
/** What the apps actually branch on. Computed, never customer-writable. */
export interface EffectiveCompanyCapabilities {
    contractVersion: ContractVersion;
    companyId: string;
    suiteLoginRequired: boolean;
    workPeriodMode: WorkPeriodMode;
    explicitShiftRequiredBeforeJobs: boolean;
    jsaEnabled: boolean;
    dvirEnabled: boolean;
    /** Fields the customer may edit under this plan. */
    customerEditableFields: Array<keyof CompanyWorkPeriodConfiguration>;
}
/**
 * One day's authoritative shift document (driver_shifts/{driver}_{date}).
 * `readable:false` means the fetch failed — NOT that the doc is absent.
 * `present:false` means it is definitively absent (e.g. HTTP 404).
 */
export interface DayShiftDoc {
    readable: boolean;
    present: boolean;
    /** '' means WB-S explicitly ended the shift; absent means no field. */
    currentShiftId?: string;
}
export interface ExplicitShiftEvidence {
    /** Authoritative doc for TODAY's local date. */
    today: DayShiftDoc;
    /** Locally cached shift id — a hint, never authority. */
    cachedShiftId?: string | null;
    /** Authoritative doc for the CACHED shift's own origin day. */
    cachedOriginDay?: DayShiftDoc | null;
    /** Deep-link supplied id — assists resolution, establishes nothing. */
    deepLinkShiftId?: string | null;
}
export interface ResolveInput {
    contractVersion: number;
    companyId: string;
    driverId: string;
    capabilities: EffectiveCompanyCapabilities;
    config: CompanyWorkPeriodConfiguration;
    /** Required for explicit_shift mode. */
    evidence?: ExplicitShiftEvidence;
    nowMs: number;
    /** The action being attempted. Omitted = a period-bound action. */
    action?: OperationalAction;
    /** Local date 'YYYY-MM-DD' the caller used to fetch `evidence.today`. */
    todayLocalDate?: string;
}
export type ResolutionSource = 'authoritative_today' | 'authoritative_origin_day' | 'derived_from_configuration';
export interface ResolvedPeriodBase {
    contractVersion: ContractVersion;
    companyId: string;
    driverId: string;
    mode: WorkPeriodMode;
    periodId: string;
    startIso: string | null;
    endIso: string | null;
    timezone: string | null;
    source: ResolutionSource;
    verifiedAtIso: string;
}
export type WorkPeriodResolution = ({
    outcome: 'ACTIVE_EXPLICIT_SHIFT';
} & ResolvedPeriodBase) | ({
    outcome: 'CURRENT_DERIVED_PERIOD';
} & ResolvedPeriodBase) | {
    outcome: 'NO_ACTIVE_SHIFT';
    contractVersion: ContractVersion;
    companyId: string;
    driverId: string;
    mode: WorkPeriodMode;
    reason: string;
} | {
    outcome: 'CLOSED_OR_SUPERSEDED';
    contractVersion: ContractVersion;
    companyId: string;
    driverId: string;
    mode: WorkPeriodMode;
    closedPeriodId: string | null;
    reason: string;
} | {
    outcome: 'UNVERIFIED_OFFLINE';
    contractVersion: ContractVersion;
    companyId: string;
    driverId: string;
    mode: WorkPeriodMode;
    reason: string;
} | {
    outcome: 'NO_PERIOD_REQUIRED';
    contractVersion: ContractVersion;
    companyId: string;
    driverId: string;
    action: OperationalAction;
    reason: string;
} | {
    outcome: 'INVALID_CONFIGURATION';
    contractVersion: ContractVersion;
    companyId: string;
    driverId: string;
    reason: string;
};
/** True only for outcomes that may authorize new operational work. */
export type OpenPeriodResolution = ({
    outcome: 'ACTIVE_EXPLICIT_SHIFT';
} & ResolvedPeriodBase) | ({
    outcome: 'CURRENT_DERIVED_PERIOD';
} & ResolvedPeriodBase);
export declare function isOperationallyOpen(r: WorkPeriodResolution): r is OpenPeriodResolution;
/**
 * Request-bound completion (signing/filing/receipts) additionally requires
 * a POSITIVELY verified period: never an unverified or offline one.
 */
export declare function mayBindRequestEvidence(r: WorkPeriodResolution): r is OpenPeriodResolution;
/**
 * WB eQuipment's DVIR records and return receipts are SHIFT-SCOPED, so it
 * must bind them to the same canonical period every other app resolves.
 * WB-S remains the sole explicit-shift lifecycle owner: eQuipment (like
 * WB-T and WB-JSA) may only CONSUME a resolution — it must never invent,
 * derive, reopen, or fall back to a shift of its own.
 */
export type ShiftScopedRecordKind = 'dvir_pre_trip' | 'dvir_post_trip' | 'equipment_return_receipt';
/** Identity every shift-scoped operational record must carry. */
export interface ShiftScopedBinding {
    contractVersion: ContractVersion;
    kind: ShiftScopedRecordKind;
    companyId: string;
    driverId: string;
    /** The resolved period this record belongs to. */
    periodId: string;
    mode: WorkPeriodMode;
    /** How the period was proven at binding time. */
    source: ResolutionSource;
    boundAtIso: string;
}
export type BindingRejection = 'period_not_open' | 'period_unverified' | 'company_mismatch' | 'driver_mismatch' | 'period_mismatch' | 'contract_version_mismatch';
/**
 * Build the binding for a new shift-scoped record. Returns a rejection
 * instead of a binding whenever the period is closed, missing, unverified,
 * or belongs to another company/driver — the same fail-closed rule that
 * governs JSA request evidence.
 */
export declare function bindShiftScopedRecord(kind: ShiftScopedRecordKind, resolution: WorkPeriodResolution, expected: {
    companyId: string;
    driverId: string;
}, nowMs: number): {
    ok: true;
    binding: ShiftScopedBinding;
} | {
    ok: false;
    rejection: BindingRejection;
};
/** Verify an existing record still matches the currently resolved period. */
export declare function verifyShiftScopedBinding(binding: ShiftScopedBinding, resolution: WorkPeriodResolution): {
    ok: true;
} | {
    ok: false;
    rejection: BindingRejection;
};
//# sourceMappingURL=types.d.ts.map