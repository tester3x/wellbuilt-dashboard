/**
 * companies/{companyId}.wellbuiltContract — strict server-side parsing
 * (vc51.9A6-B). ONE nested protected root object, Mike-approved shape:
 *
 *   wellbuiltContract: {
 *     contractVersion, configurationVersion, planId,
 *     entitlementOverrides, workPeriodConfiguration?, contractEnforced
 *   }
 *
 * Deliberate exclusions (validated, not just documented):
 *   - NO mutable current-shift state (the live shift is WB-S's record);
 *   - NO persisted EffectiveCompanyCapabilities (always computed);
 *   - NO client actor/timestamp fields inside policy data (actors and
 *     timestamps live in platform_admin_audit, server-derived).
 *
 * `configurationVersion` lives at the contract ROOT and increments on
 * every protected mutation. The stored workPeriodConfiguration
 * deliberately omits the contracts-package `contractVersion` /
 * `configurationVersion` fields so the same version can never drift in
 * two places — `toContractsWorkPeriodConfiguration` materializes the
 * full @tester3x/wellbuilt-contracts shape by injecting the root versions.
 *
 * The legacy company `tier` field is untouched and non-authoritative.
 */

import {
  CONTRACT_VERSION,
  validateCompanyAppConfigurations,
  type CompanyAppConfigurations,
  type CompanyWorkPeriodConfiguration,
  type EntitlementOverride,
  type PlanCapability,
  type WorkPeriodMode,
  isValidTimezone,
} from '@tester3x/wellbuilt-contracts';

export const WELLBUILT_CONTRACT_KEY = 'wellbuiltContract' as const;

/** Runtime mirror of the PlanCapability union, type-anchored so a
 *  contracts change breaks this build instead of silently drifting. */
export const PLAN_CAPABILITIES: readonly PlanCapability[] = Object.freeze([
  'jsa', 'dvir', 'explicitShiftLifecycle', 'companyDefinedWorkPeriod',
  'dispatch', 'billing',
] satisfies readonly PlanCapability[]);

export const WORK_PERIOD_MODES: readonly WorkPeriodMode[] = Object.freeze([
  'explicit_shift', 'company_defined_period',
] satisfies readonly WorkPeriodMode[]);

/** Stored nested work-period configuration (versions live at contract root). */
export interface StoredWorkPeriodConfiguration {
  mode: WorkPeriodMode;
  timezone?: string;
  startLocalTime?: string;
  durationMinutes?: number;
}

/** The stored wellbuiltContract object. */
export interface WellbuiltContract {
  contractVersion: number;
  configurationVersion: number;
  planId: string;
  entitlementOverrides: EntitlementOverride[];
  workPeriodConfiguration?: StoredWorkPeriodConfiguration;
  contractEnforced: boolean;
  /**
   * Per-app OPERATIONAL configuration (vc51.9M, optional).
   *
   * The plan says what this company bought; this says how it runs it.
   * Narrowing only — it may disable an included app or ADD a shift
   * requirement, never enable an excluded one or remove a plan-level
   * gate. Absent means this company adds nothing, which is exactly the
   * behaviour every contract had before the field existed.
   */
  appConfiguration?: CompanyAppConfigurations;
}

export type CompanyContractState =
  /** No wellbuiltContract field — legacy/unconfigured company. */
  | { state: 'legacy' }
  /** Valid contract, contractEnforced === false. */
  | { state: 'inert'; contract: WellbuiltContract }
  /** Valid contract, contractEnforced === true. */
  | { state: 'active'; contract: WellbuiltContract }
  /** Present but unsupported/malformed — NEVER treated as legacy. */
  | { state: 'invalid'; reason: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const OVERRIDE_REASON_MAX = 300;
export const MAX_OVERRIDES = 20;

const CONTRACT_KEYS = ['contractVersion', 'configurationVersion', 'planId',
  'entitlementOverrides', 'workPeriodConfiguration', 'contractEnforced',
  // vc51.9M — per-app OPERATIONAL configuration. Optional: a contract
  // without it is unchanged in every respect. Nested inside the contract
  // root, so it inherits that root's client-write protection and needs no
  // rules change; and because it lives here, one transactional write and
  // one configurationVersion bump cover it like every other contract field.
  'appConfiguration'];
const OVERRIDE_KEYS = ['capability', 'granted', 'reason', 'grantedBy', 'grantedAt', 'expiresAt'];
const WPC_KEYS = ['mode', 'timezone', 'startLocalTime', 'durationMinutes'];

function invalid(reason: string): CompanyContractState {
  return { state: 'invalid', reason };
}

export function parseEntitlementOverride(v: unknown): { ok: true; override: EntitlementOverride } | { ok: false; reason: string } {
  if (!isPlainObject(v)) return { ok: false, reason: 'override_not_object' };
  const unknown = Object.keys(v).filter((k) => !OVERRIDE_KEYS.includes(k));
  if (unknown.length) return { ok: false, reason: `override_unknown_keys:${unknown.join(',')}` };
  if (!PLAN_CAPABILITIES.includes(v.capability as PlanCapability)) {
    return { ok: false, reason: `override_unknown_capability:${String(v.capability)}` };
  }
  if (typeof v.granted !== 'boolean') return { ok: false, reason: 'override_granted_not_boolean' };
  if (typeof v.reason !== 'string' || v.reason.trim().length === 0 || v.reason.length > OVERRIDE_REASON_MAX) {
    return { ok: false, reason: 'override_reason_missing_or_unbounded' };
  }
  if (typeof v.grantedBy !== 'string' || v.grantedBy.length === 0) {
    return { ok: false, reason: 'override_grantedBy_missing' };
  }
  if (typeof v.grantedAt !== 'string' || !ISO_RE.test(v.grantedAt)) {
    return { ok: false, reason: 'override_grantedAt_not_iso' };
  }
  if (v.expiresAt !== undefined && v.expiresAt !== null &&
      (typeof v.expiresAt !== 'string' || !ISO_RE.test(v.expiresAt))) {
    return { ok: false, reason: 'override_expiresAt_not_iso_or_null' };
  }
  return {
    ok: true,
    override: {
      capability: v.capability as PlanCapability,
      granted: v.granted,
      reason: v.reason,
      grantedBy: v.grantedBy,
      grantedAt: v.grantedAt,
      ...(v.expiresAt !== undefined ? { expiresAt: v.expiresAt as string | null } : {}),
    },
  };
}

export function parseStoredWorkPeriodConfiguration(v: unknown): { ok: true; config: StoredWorkPeriodConfiguration } | { ok: false; reason: string } {
  if (!isPlainObject(v)) return { ok: false, reason: 'work_period_configuration_not_object' };
  const unknown = Object.keys(v).filter((k) => !WPC_KEYS.includes(k));
  if (unknown.length) return { ok: false, reason: `work_period_unknown_keys:${unknown.join(',')}` };
  if (!WORK_PERIOD_MODES.includes(v.mode as WorkPeriodMode)) {
    return { ok: false, reason: `work_period_unknown_mode:${String(v.mode)}` };
  }
  if (v.timezone !== undefined && (typeof v.timezone !== 'string' || !isValidTimezone(v.timezone))) {
    return { ok: false, reason: 'work_period_invalid_timezone' };
  }
  if (v.startLocalTime !== undefined && (typeof v.startLocalTime !== 'string' || !TIME_RE.test(v.startLocalTime))) {
    return { ok: false, reason: 'work_period_invalid_start_local_time' };
  }
  if (v.durationMinutes !== undefined &&
      (typeof v.durationMinutes !== 'number' || !Number.isInteger(v.durationMinutes) ||
       v.durationMinutes <= 0 || v.durationMinutes > 24 * 60)) {
    return { ok: false, reason: 'work_period_invalid_duration_minutes' };
  }
  const config: StoredWorkPeriodConfiguration = { mode: v.mode as WorkPeriodMode };
  if (v.timezone !== undefined) config.timezone = v.timezone as string;
  if (v.startLocalTime !== undefined) config.startLocalTime = v.startLocalTime as string;
  if (v.durationMinutes !== undefined) config.durationMinutes = v.durationMinutes as number;
  return { ok: true, config };
}

/**
 * Parse the raw `wellbuiltContract` field of a company document.
 * `undefined` is the ONLY input that yields `legacy`; every malformed or
 * future-versioned value is `invalid` (upgrade-required), never a silent
 * legacy fallback.
 */
export function parseCompanyContract(raw: unknown): CompanyContractState {
  if (raw === undefined) return { state: 'legacy' };
  if (!isPlainObject(raw)) return invalid('contract_not_object');
  const unknown = Object.keys(raw).filter((k) => !CONTRACT_KEYS.includes(k));
  if (unknown.length) return invalid(`contract_unknown_keys:${unknown.join(',')}`);

  if (raw.contractVersion !== CONTRACT_VERSION) {
    return invalid(`unsupported_contract_version:${String(raw.contractVersion)}`);
  }
  if (typeof raw.configurationVersion !== 'number' || !Number.isInteger(raw.configurationVersion) || raw.configurationVersion < 1) {
    return invalid('unsupported_configuration_version');
  }
  if (typeof raw.planId !== 'string' || !PLAN_ID_RE.test(raw.planId)) {
    return invalid('invalid_plan_id');
  }
  if (!Array.isArray(raw.entitlementOverrides) || raw.entitlementOverrides.length > MAX_OVERRIDES) {
    return invalid('invalid_entitlement_overrides');
  }
  const overrides: EntitlementOverride[] = [];
  for (const o of raw.entitlementOverrides) {
    const parsed = parseEntitlementOverride(o);
    if (!parsed.ok) return invalid(parsed.reason);
    overrides.push(parsed.override);
  }
  let workPeriodConfiguration: StoredWorkPeriodConfiguration | undefined;
  if (raw.workPeriodConfiguration !== undefined) {
    const parsed = parseStoredWorkPeriodConfiguration(raw.workPeriodConfiguration);
    if (!parsed.ok) return invalid(parsed.reason);
    workPeriodConfiguration = parsed.config;
  }
  if (typeof raw.contractEnforced !== 'boolean') return invalid('contract_enforced_not_boolean');

  // Validated by the CANONICAL validator, never by a local reading of the
  // shape. Malformed stored configuration makes the whole contract
  // invalid — the same fail-closed classification a malformed work-period
  // configuration already gets — rather than being dropped or repaired on
  // read, which would hide corruption behind a plausible-looking contract.
  let appConfiguration: CompanyAppConfigurations | undefined;
  if (raw.appConfiguration !== undefined) {
    const parsed = validateCompanyAppConfigurations(raw.appConfiguration);
    if (!parsed.ok) {
      return invalid(`invalid_app_configuration:${parsed.rejection}${parsed.key ? `:${parsed.key}` : ''}`);
    }
    // `present` is guaranteed here: only `undefined` returns absent, and
    // that case is excluded above. Stored in CANONICAL normalized form, so
    // persistence can never disagree with what the resolver reads back.
    if (parsed.present) appConfiguration = parsed.value;
  }

  const contract: WellbuiltContract = {
    contractVersion: CONTRACT_VERSION,
    configurationVersion: raw.configurationVersion,
    planId: raw.planId,
    entitlementOverrides: overrides,
    ...(workPeriodConfiguration ? { workPeriodConfiguration } : {}),
    contractEnforced: raw.contractEnforced,
    // Only when the stored document actually had the key, so genuine
    // absence stays absence rather than becoming a key holding undefined.
    ...(appConfiguration !== undefined ? { appConfiguration } : {}),
  };
  return contract.contractEnforced
    ? { state: 'active', contract }
    : { state: 'inert', contract };
}

/**
 * Enforcement gate: a contract may only be enforced when its
 * work-period configuration is COMPLETE for its mode.
 */
export function isWorkPeriodConfigurationComplete(cfg: StoredWorkPeriodConfiguration | undefined): { complete: true } | { complete: false; reason: string } {
  if (!cfg) return { complete: false, reason: 'work_period_configuration_missing' };
  if (cfg.mode === 'explicit_shift') return { complete: true };
  if (!cfg.timezone || !isValidTimezone(cfg.timezone)) return { complete: false, reason: 'derived_mode_requires_timezone' };
  if (!cfg.startLocalTime) return { complete: false, reason: 'derived_mode_requires_start_local_time' };
  if (typeof cfg.durationMinutes !== 'number') return { complete: false, reason: 'derived_mode_requires_duration_minutes' };
  return { complete: true };
}

/** Materialize the full contracts-package configuration shape (root
 *  versions injected — the single place the two shapes meet). */
export function toContractsWorkPeriodConfiguration(contract: WellbuiltContract): CompanyWorkPeriodConfiguration | null {
  const cfg = contract.workPeriodConfiguration;
  if (!cfg) return null;
  return {
    contractVersion: CONTRACT_VERSION,
    configurationVersion: contract.configurationVersion,
    mode: cfg.mode,
    ...(cfg.timezone !== undefined ? { timezone: cfg.timezone } : {}),
    ...(cfg.startLocalTime !== undefined ? { startLocalTime: cfg.startLocalTime } : {}),
    ...(cfg.durationMinutes !== undefined ? { durationMinutes: cfg.durationMinutes } : {}),
  };
}
