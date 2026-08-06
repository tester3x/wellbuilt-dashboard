/**
 * Effective company capabilities — ONE pure server helper (vc51.9A6-B).
 *
 * EffectiveCompanyCapabilities is NEVER persisted. It is computed on
 * demand from:
 *   - the validated company wellbuiltContract (companyContract.ts);
 *   - the exact assigned plans/{planId} PlanDefinition;
 *   - active/unexpired entitlement overrides;
 *   - @wellbuilt/contracts (assertContractCompatible + types).
 *
 * No database I/O — callers fetch, this computes. Typed failures, never
 * throws for policy conditions.
 *
 * Mixed-workflow pin (Liquid Gold): computing capabilities NEVER turns
 * suite login into a shift requirement. `app_use` resolves
 * NO_PERIOD_REQUIRED through requiresWorkPeriod regardless of mode;
 * only shift-scoped operational actions (wbt_job_start / jsa_request /
 * equipment_dvir) bind to a verified period. suiteLoginRequired is not
 * contract-controlled in v1 and is always false here.
 *
 * Override semantics: expired overrides (expiresAt <= now) are ignored;
 * active overrides apply IN ARRAY ORDER, so on conflict the LAST active
 * entry for a capability wins (deterministic, matches audit history
 * order — overrides are appended).
 *
 * Plan deprecation does NOT fail computation: deprecating a plan must
 * never silently alter already-assigned companies. The result carries
 * `planDeprecated` so callers can surface it.
 */

import {
  CONTRACT_VERSION,
  assertContractCompatible,
  isValidTimezone,
  type EffectiveCompanyCapabilities,
  type PlanCapability,
  type PlanDefinition,
} from '@wellbuilt/contracts';
import {
  isWorkPeriodConfigurationComplete,
  type WellbuiltContract,
} from './companyContract';

export type CapabilityFailure =
  | { ok: false; code: 'unsupported_contract_version'; detail: string }
  | { ok: false; code: 'plan_mismatch'; detail: string }
  | { ok: false; code: 'missing_work_period_configuration'; detail: string }
  | { ok: false; code: 'invalid_work_period_configuration'; detail: string }
  | { ok: false; code: 'mode_not_entitled'; detail: string };

export interface CapabilitySuccess {
  ok: true;
  capabilities: EffectiveCompanyCapabilities;
  /** The plan is deprecated — computation still valid, surface it. */
  planDeprecated: boolean;
  /** Capabilities granted/revoked by active overrides (for preview UIs). */
  overrideAdjusted: PlanCapability[];
}

export type CapabilityResult = CapabilitySuccess | CapabilityFailure;

export function computeEffectiveCapabilities(input: {
  companyId: string;
  plan: PlanDefinition;
  contract: WellbuiltContract;
  nowMs: number;
}): CapabilityResult {
  const { companyId, plan, contract, nowMs } = input;

  try {
    assertContractCompatible(contract.contractVersion, 'functions:effectiveCapabilities');
    assertContractCompatible(plan.contractVersion, 'functions:effectiveCapabilities(plan)');
  } catch (err) {
    return { ok: false, code: 'unsupported_contract_version', detail: (err as Error).message };
  }

  if (plan.planId !== contract.planId) {
    return {
      ok: false, code: 'plan_mismatch',
      detail: `contract assigns ${contract.planId} but plan document is ${plan.planId}`,
    };
  }

  // Overrides: expired ignored; active applied in order (last wins).
  const caps = new Set<PlanCapability>(plan.capabilities);
  const adjusted = new Set<PlanCapability>();
  for (const o of contract.entitlementOverrides) {
    if (o.expiresAt && Date.parse(o.expiresAt) <= nowMs) continue;
    adjusted.add(o.capability);
    if (o.granted) caps.add(o.capability);
    else caps.delete(o.capability);
  }

  const cfg = contract.workPeriodConfiguration;
  if (!cfg) {
    return {
      ok: false, code: 'missing_work_period_configuration',
      detail: 'wellbuiltContract.workPeriodConfiguration is absent',
    };
  }
  if (cfg.mode === 'company_defined_period') {
    if (!caps.has('companyDefinedWorkPeriod')) {
      return {
        ok: false, code: 'mode_not_entitled',
        detail: 'company_defined_period requires the companyDefinedWorkPeriod capability',
      };
    }
    const complete = isWorkPeriodConfigurationComplete(cfg);
    if (!complete.complete) {
      return { ok: false, code: 'invalid_work_period_configuration', detail: complete.reason };
    }
    if (!isValidTimezone(cfg.timezone)) {
      return { ok: false, code: 'invalid_work_period_configuration', detail: 'invalid_timezone' };
    }
  }

  const capabilities: EffectiveCompanyCapabilities = {
    contractVersion: CONTRACT_VERSION,
    companyId,
    // Not contract-controlled in v1; login NEVER implies a shift.
    suiteLoginRequired: false,
    workPeriodMode: cfg.mode,
    explicitShiftRequiredBeforeJobs:
      cfg.mode === 'explicit_shift' && caps.has('explicitShiftLifecycle'),
    jsaEnabled: caps.has('jsa'),
    dvirEnabled: caps.has('dvir'),
    customerEditableFields:
      cfg.mode === 'company_defined_period' && caps.has('companyDefinedWorkPeriod')
        ? ['timezone', 'startLocalTime', 'durationMinutes']
        : [],
  };

  return {
    ok: true,
    capabilities,
    planDeprecated: plan.status === 'deprecated',
    overrideAdjusted: [...adjusted],
  };
}
