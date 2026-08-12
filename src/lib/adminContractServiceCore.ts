/**
 * Typed Dashboard service for the vc51.9A6-B protected admin callables.
 *
 * CALLABLE-ONLY BY CONSTRUCTION: this module imports nothing from
 * 'firebase/firestore' and holds no document references — there is no
 * direct protected-write fallback, and tools/test-adminService.mjs pins
 * that property on the source. Future Admin UI goes through these
 * functions exclusively.
 *
 * Every method returns the callable's typed minimal response or throws
 * AdminServiceError with a NORMALIZED kind, so UI code never string-
 * matches backend messages:
 *
 *   unauthenticated       — no verified session
 *   missing_claim         — signed in, but no wellbuiltAdmin claim
 *   disabled_admin        — claim present but the server-owned
 *                           platform_admins record denies (missing,
 *                           disabled, malformed, or policy-version)
 *   validation            — payload rejected (unknown/invalid fields,
 *                           limits, preconditions like plan_deprecated)
 *   incompatible_contract — the stored contract is unsupported/
 *                           malformed or cannot be enforced/computed
 *   not_found / conflict  — targeted document absent / already exists
 *   retryable             — transient backend failure; safe to retry
 *   unknown               — anything else (bug — surface loudly)
 *
 * DEPENDENCY-FREE CORE: no imports at all, so tests drive it directly
 * (tools/test-adminService.mjs) with an injected CallFn. The production
 * transport lives in adminContractService.ts, which binds
 * createAdminContractServiceCore to httpsCallable.
 */

// ── wire types (mirror functions/src/admin/adminHandlers.ts responses) ────

export type PlanCapability =
  | 'jsa' | 'dvir' | 'explicitShiftLifecycle'
  | 'companyDefinedWorkPeriod' | 'dispatch' | 'billing';
export type WorkPeriodMode = 'explicit_shift' | 'company_defined_period';

export interface PlanDefinition {
  contractVersion: number;
  planId: string;
  displayName: string;
  capabilities: PlanCapability[];
  status: 'active' | 'deprecated';
  /**
   * Per-app commercial entitlement, as STORED.
   *
   * Deliberately `unknown`: this is a value read back from a document, not
   * a promise about its shape, and a legacy plan omits it entirely. Only
   * the canonical validator may decide whether it is absent, an
   * authoritative empty map, a configured map, or unusable — see
   * lib/planEntitlement.ts. Nothing may read it as a typed map directly.
   */
  apps?: unknown;
}

export interface StoredWorkPeriodConfiguration {
  mode: WorkPeriodMode;
  timezone?: string;
  startLocalTime?: string;
  durationMinutes?: number;
}

export interface EntitlementOverride {
  capability: PlanCapability;
  granted: boolean;
  reason: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string | null;
}

export interface WellbuiltContract {
  contractVersion: number;
  configurationVersion: number;
  planId: string;
  entitlementOverrides: EntitlementOverride[];
  workPeriodConfiguration?: StoredWorkPeriodConfiguration;
  contractEnforced: boolean;
  /**
   * Per-app OPERATIONAL configuration, as STORED.
   *
   * `unknown` for the same reason plan `apps` is: this is a value read
   * back from a document, not a promise about its shape. Only the
   * canonical validator may decide whether it is absent, an authoritative
   * empty map, configured, or unusable — see lib/companyAppSettings.ts.
   */
  appConfiguration?: unknown;
}

export type CompanyContractStateLabel = 'legacy' | 'inert' | 'active' | 'invalid';

export interface EffectiveCompanyCapabilities {
  contractVersion: number;
  companyId: string;
  suiteLoginRequired: boolean;
  workPeriodMode: WorkPeriodMode;
  explicitShiftRequiredBeforeJobs: boolean;
  jsaEnabled: boolean;
  dvirEnabled: boolean;
  customerEditableFields: string[];
}

export type CapabilityResult =
  | { ok: true; capabilities: EffectiveCompanyCapabilities; planDeprecated: boolean; overrideAdjusted: PlanCapability[] }
  | { ok: false; code: string; detail: string };

export interface AdminAuditEntry {
  auditId: string;
  operation: string;
  targetType: 'plan' | 'company';
  targetId: string;
  actorUid: string;
  actorEmail: string | null;
  contractVersion: number;
  adminPolicyVersion: number;
  reason?: string;
  changedFields?: string[];
}

// ── normalized errors ─────────────────────────────────────────────────────

export type AdminServiceErrorKind =
  | 'unauthenticated' | 'missing_claim' | 'disabled_admin'
  | 'validation' | 'incompatible_contract'
  | 'not_found' | 'conflict' | 'retryable' | 'unknown';

export class AdminServiceError extends Error {
  readonly kind: AdminServiceErrorKind;
  readonly adminCode: string | null;
  constructor(kind: AdminServiceErrorKind, adminCode: string | null, message?: string) {
    super(message ?? adminCode ?? kind);
    this.kind = kind;
    this.adminCode = adminCode;
  }
}

const DISABLED_ADMIN_CODES = [
  'no_admin_record', 'admin_record_disabled', 'admin_record_malformed', 'unsupported_policy_version',
];
const MISSING_CLAIM_CODES = ['missing_admin_claim', 'claim_not_true'];
const INCOMPATIBLE_PREFIXES = ['invalid_existing_contract', 'not_enforceable', 'unsupported_contract_version'];
const RETRYABLE_CODES = ['unavailable', 'deadline-exceeded', 'internal', 'resource-exhausted', 'aborted', 'cancelled'];

export function normalizeAdminError(err: unknown): AdminServiceError {
  if (err instanceof AdminServiceError) return err;
  const e = err as { code?: string; message?: string; details?: { adminCode?: string } };
  // firebase/functions surfaces HttpsError as code 'functions/<code>'.
  const code = (e?.code ?? '').replace(/^functions\//, '');
  const adminCode = e?.details?.adminCode ?? null;

  if (code === 'unauthenticated') return new AdminServiceError('unauthenticated', adminCode);
  if (code === 'permission-denied') {
    if (adminCode && MISSING_CLAIM_CODES.includes(adminCode)) {
      return new AdminServiceError('missing_claim', adminCode);
    }
    if (adminCode && DISABLED_ADMIN_CODES.includes(adminCode)) {
      return new AdminServiceError('disabled_admin', adminCode);
    }
    // protected_field:* and any other explicit denial is a validation-
    // class rejection of the request, not an authority problem.
    return new AdminServiceError('validation', adminCode, e?.message);
  }
  if (code === 'failed-precondition') {
    if (adminCode && INCOMPATIBLE_PREFIXES.some((p) => adminCode.startsWith(p))) {
      return new AdminServiceError('incompatible_contract', adminCode);
    }
    return new AdminServiceError('validation', adminCode, e?.message);
  }
  if (code === 'invalid-argument') return new AdminServiceError('validation', adminCode, e?.message);
  if (code === 'not-found') return new AdminServiceError('not_found', adminCode);
  if (code === 'already-exists') return new AdminServiceError('conflict', adminCode);
  if (RETRYABLE_CODES.includes(code)) return new AdminServiceError('retryable', adminCode, e?.message);
  return new AdminServiceError('unknown', adminCode, e?.message);
}

// ── service ───────────────────────────────────────────────────────────────

/** Injectable transport: (callableName, payload) → response data. */
export type CallFn = (name: string, data: unknown) => Promise<unknown>;

export interface AdminContractService {
  // `apps` is OPTIONAL on both, and omission is meaningful: on create it
  // stores a genuinely absent field, on update it leaves the stored value
  // untouched. A deliberate `{}` is a real value and is sent.
  //
  // Typed `unknown`, like the response side, because this module is a
  // TRANSPORT and stays import-free by design (pinned by
  // tools/test-adminService.mjs). The canonical map type and its
  // validation live in lib/planEntitlement.ts, which legitimately imports
  // contracts; the backend remains the authoritative write boundary.
  createPlan(input: { planId: string; displayName: string; capabilities: PlanCapability[]; apps?: unknown }): Promise<{ planId: string; status: 'active' }>;
  updatePlan(input: { planId: string; displayName?: string; capabilities?: PlanCapability[]; apps?: unknown }): Promise<{ planId: string; changedFields: string[] }>;
  deprecatePlan(input: { planId: string }): Promise<{ planId: string; status: 'deprecated' }>;
  assignCompanyPlan(input: { companyId: string; planId: string; allowDeprecatedPlanForMigration?: boolean }): Promise<{ companyId: string; planId: string; configurationVersion: number }>;
  addEntitlementOverride(input: { companyId: string; capability: PlanCapability; granted: boolean; reason: string; expiresAt?: string | null }): Promise<{ companyId: string; capability: PlanCapability; configurationVersion: number }>;
  removeEntitlementOverride(input: { companyId: string; capability: PlanCapability; reason: string }): Promise<{ companyId: string; capability: PlanCapability; removed: number; configurationVersion: number }>;
  setCompanyWorkPeriodConfiguration(input: { companyId: string; configuration: StoredWorkPeriodConfiguration }): Promise<{ companyId: string; configurationVersion: number }>;
  // configurationVersion is SERVER-OWNED: it is never sent, and the
  // callable rejects it as an unknown field if it ever were.
  setCompanyAppConfiguration(input: { companyId: string; appConfiguration: unknown }): Promise<{ companyId: string; configurationVersion: number }>;
  setCompanyContractEnforcement(input: { companyId: string; enforced: boolean }): Promise<{ companyId: string; contractEnforced: boolean; configurationVersion: number }>;
  updateCompanySafe(input: { companyId: string; fields: Record<string, unknown> }): Promise<{ companyId: string; changedFields: string[] }>;
  archiveCompany(input: { companyId: string; confirmCompanyId: string; reason: string }): Promise<{ companyId: string; status: 'archived' }>;
  listPlans(input?: { limit?: number; cursor?: string }): Promise<{ plans: PlanDefinition[]; nextCursor: string | null }>;
  getPlan(input: { planId: string }): Promise<{ plan: PlanDefinition }>;
  getCompanyContractConfiguration(input: { companyId: string }): Promise<{ companyId: string; state: CompanyContractStateLabel; contract?: WellbuiltContract; invalidReason?: string }>;
  previewCompanyEffectiveCapabilities(input: { companyId: string }): Promise<{ companyId: string; state: CompanyContractStateLabel; result?: CapabilityResult; invalidReason?: string }>;
  listAdminAudit(input?: { limit?: number; cursor?: string }): Promise<{ entries: AdminAuditEntry[]; nextCursor: string | null }>;
}

const CALLABLE_NAMES = {
  createPlan: 'adminCreatePlan',
  updatePlan: 'adminUpdatePlan',
  deprecatePlan: 'adminDeprecatePlan',
  assignCompanyPlan: 'adminAssignCompanyPlan',
  addEntitlementOverride: 'adminAddEntitlementOverride',
  removeEntitlementOverride: 'adminRemoveEntitlementOverride',
  setCompanyWorkPeriodConfiguration: 'adminSetCompanyWorkPeriodConfiguration',
  setCompanyAppConfiguration: 'adminSetCompanyAppConfiguration',
  setCompanyContractEnforcement: 'adminSetCompanyContractEnforcement',
  updateCompanySafe: 'adminUpdateCompanySafe',
  archiveCompany: 'adminArchiveCompany',
  listPlans: 'adminListPlans',
  getPlan: 'adminGetPlan',
  getCompanyContractConfiguration: 'adminGetCompanyContractConfiguration',
  previewCompanyEffectiveCapabilities: 'adminPreviewCompanyEffectiveCapabilities',
  listAdminAudit: 'adminListAdminAudit',
} as const;

export function createAdminContractServiceCore(call: CallFn): AdminContractService {
  const transport = call;
  const invoke = async <T>(name: string, data: unknown): Promise<T> => {
    try {
      return (await transport(name, data)) as T;
    } catch (err) {
      throw normalizeAdminError(err);
    }
  };
  return {
    createPlan: (i) => invoke(CALLABLE_NAMES.createPlan, i),
    updatePlan: (i) => invoke(CALLABLE_NAMES.updatePlan, i),
    deprecatePlan: (i) => invoke(CALLABLE_NAMES.deprecatePlan, i),
    assignCompanyPlan: (i) => invoke(CALLABLE_NAMES.assignCompanyPlan, i),
    addEntitlementOverride: (i) => invoke(CALLABLE_NAMES.addEntitlementOverride, i),
    removeEntitlementOverride: (i) => invoke(CALLABLE_NAMES.removeEntitlementOverride, i),
    setCompanyWorkPeriodConfiguration: (i) => invoke(CALLABLE_NAMES.setCompanyWorkPeriodConfiguration, i),
    setCompanyAppConfiguration: (i) => invoke(CALLABLE_NAMES.setCompanyAppConfiguration, i),
    setCompanyContractEnforcement: (i) => invoke(CALLABLE_NAMES.setCompanyContractEnforcement, i),
    updateCompanySafe: (i) => invoke(CALLABLE_NAMES.updateCompanySafe, i),
    archiveCompany: (i) => invoke(CALLABLE_NAMES.archiveCompany, i),
    listPlans: (i = {}) => invoke(CALLABLE_NAMES.listPlans, i),
    getPlan: (i) => invoke(CALLABLE_NAMES.getPlan, i),
    getCompanyContractConfiguration: (i) => invoke(CALLABLE_NAMES.getCompanyContractConfiguration, i),
    previewCompanyEffectiveCapabilities: (i) => invoke(CALLABLE_NAMES.previewCompanyEffectiveCapabilities, i),
    listAdminAudit: (i = {}) => invoke(CALLABLE_NAMES.listAdminAudit, i),
  };
}

export { CALLABLE_NAMES as ADMIN_CALLABLE_NAMES };
