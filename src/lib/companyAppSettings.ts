/**
 * vc51.9M — per-company app operation settings, as pure logic.
 *
 * TWO QUESTIONS, TWO SURFACES. The Plan Catalog answers "which apps did
 * this commercial plan purchase?". This answers "how do those purchased
 * apps operate for THIS company?". Company settings may narrow — disable
 * an included app, or require an active shift for it — and can never
 * include an app the plan excludes, nor relax a restriction the plan
 * mandates for every company assigned to it.
 *
 * Every rule is contracts 0.4.0's. The plan side is read through
 * `resolveAppEntitlement`, the company side through
 * `validateCompanyAppConfigurations`, and nothing about app keys, aliases,
 * the core-app rule, or entry shapes is restated here — which is what
 * makes it impossible for this editor to build something the backend
 * would refuse, or to display a company setting the resolver would ignore.
 */

import {
  WELLBUILT_APP_KEYS,
  isCoreApp,
  resolveAppEntitlement,
  validateCompanyAppConfigurations,
  type CompanyAppConfigurations,
  type WellbuiltAppKey,
} from '@tester3x/wellbuilt-contracts';

/**
 * No RELATIVE imports, deliberately — the same discipline planEntitlement
 * keeps. These pure lib modules are driven directly by node harnesses, so
 * a relative dependency would make the model unloadable outside a bundler.
 * The app KEYS come from the contract; the human-facing product NAMES are
 * presentation and stay in the component's own import.
 */
export const DESTINATION_APPS: readonly WellbuiltAppKey[] = Object.freeze(
  WELLBUILT_APP_KEYS.filter((k) => !isCoreApp(k)),
);

/** What the PLAN says about one app — the ceiling this company sits under. */
export type PlanAppStatus =
  | { kind: 'included'; planMandatesShift: boolean }
  | { kind: 'excluded' }
  | { kind: 'legacy' }
  | { kind: 'invalid'; reason: string };

export function planAppStatus(
  plan: { planId: string; apps?: unknown } | null,
  app: WellbuiltAppKey,
): PlanAppStatus {
  if (!plan) return { kind: 'legacy' };
  const r = resolveAppEntitlement(plan, app);
  switch (r.outcome) {
    case 'INCLUDED_NO_SHIFT_REQUIRED': return { kind: 'included', planMandatesShift: false };
    case 'INCLUDED_REQUIRES_ACTIVE_SHIFT': return { kind: 'included', planMandatesShift: true };
    case 'LEGACY_UNCONFIGURED': return { kind: 'legacy' };
    case 'INVALID_ENTITLEMENT_DATA': return { kind: 'invalid', reason: r.reason };
    default: return { kind: 'excluded' };
  }
}

// ── display ───────────────────────────────────────────────────────────────

export type CompanyAppSettingsDisplay =
  | { kind: 'absent'; label: string; tone: 'neutral' }
  | { kind: 'none'; label: string; tone: 'neutral' }
  | { kind: 'configured'; label: string; tone: 'info'; restricted: number }
  | { kind: 'invalid'; label: string; tone: 'danger'; reason: string };

/**
 * Classify a company's stored `appConfiguration` for display.
 *
 * Absent and `{}` both mean "no company-specific restrictions", but they
 * are DIFFERENT states and are shown differently: absence is a company
 * that has never been configured, `{}` is a deliberate statement that this
 * company adds nothing. Invalid data is never shown as either.
 */
export function describeCompanyAppSettings(configuration: unknown): CompanyAppSettingsDisplay {
  const v = validateCompanyAppConfigurations(configuration);
  if (!v.ok) {
    return {
      kind: 'invalid',
      tone: 'danger',
      label: 'Invalid company app settings',
      reason: v.key ? `${v.rejection}: ${v.key}` : v.rejection,
    };
  }
  if (!v.present) {
    return { kind: 'absent', tone: 'neutral', label: 'No company-specific app restrictions.' };
  }
  const restricted = DESTINATION_APPS.filter(
    (a) => v.value[a]?.enabled === false || v.value[a]?.requiresActiveShift === true,
  ).length;
  if (restricted === 0) {
    return { kind: 'none', tone: 'neutral', label: 'Configured — no company-specific restrictions.' };
  }
  return {
    kind: 'configured',
    tone: 'info',
    label: `${restricted} of ${DESTINATION_APPS.length} apps restricted for this company`,
    restricted,
  };
}

// ── editing ───────────────────────────────────────────────────────────────

export interface CompanyAppRow {
  app: WellbuiltAppKey;
  plan: PlanAppStatus;
  /** Only meaningful for a plan-included app. */
  enabled: boolean;
  companyRequiresShift: boolean;
  /** True when the PLAN mandates the gate — shown inherited, not removable. */
  planMandatesShift: boolean;
  /** False for excluded/legacy-invalid plan states: nothing to configure. */
  configurable: boolean;
}

export interface CompanyAppSettingsDraft {
  state: 'absent' | 'configured' | 'invalid';
  rows: CompanyAppRow[];
  invalidReason?: string;
}

function buildRows(
  plan: { planId: string; apps?: unknown } | null,
  config: CompanyAppConfigurations | undefined,
): CompanyAppRow[] {
  return DESTINATION_APPS.map((app) => {
    const status = planAppStatus(plan, app);
    const included = status.kind === 'included';
    return {
      app,
      plan: status,
      // A company setting only means anything for an app the plan includes.
      enabled: config?.[app]?.enabled !== false,
      companyRequiresShift: config?.[app]?.requiresActiveShift === true,
      planMandatesShift: included && status.planMandatesShift,
      configurable: included,
    };
  });
}

export function draftFromContract(
  plan: { planId: string; apps?: unknown } | null,
  configuration: unknown,
): CompanyAppSettingsDraft {
  const v = validateCompanyAppConfigurations(configuration);
  if (!v.ok) {
    return {
      state: 'invalid',
      rows: buildRows(plan, undefined),
      invalidReason: v.key ? `${v.rejection}: ${v.key}` : v.rejection,
    };
  }
  return {
    state: v.present ? 'configured' : 'absent',
    rows: buildRows(plan, v.present ? v.value : undefined),
  };
}

/**
 * The deliberate act that materializes a configuration.
 *
 * Viewing a company, opening the section, and cancelling must all leave
 * absence intact — `{}` is a real statement and nobody should make it by
 * accident. This is also the repair path out of invalid stored data.
 */
export function beginConfiguringCompany(d: CompanyAppSettingsDraft): CompanyAppSettingsDraft {
  if (d.state === 'configured') return d;
  return { state: 'configured', rows: d.rows.map((r) => ({ ...r })) };
}

export function setCompanyAppEnabled(
  d: CompanyAppSettingsDraft, app: WellbuiltAppKey, enabled: boolean,
): CompanyAppSettingsDraft {
  if (d.state !== 'configured') return d;
  return {
    ...d,
    rows: d.rows.map((r) => (r.app !== app || !r.configurable ? r : {
      ...r,
      enabled,
      // A shift requirement on an app this company switched off is
      // contradictory, and the contract rejects it outright.
      companyRequiresShift: enabled ? r.companyRequiresShift : false,
    })),
  };
}

export function setCompanyAppRequiresShift(
  d: CompanyAppSettingsDraft, app: WellbuiltAppKey, requires: boolean,
): CompanyAppSettingsDraft {
  if (d.state !== 'configured') return d;
  return {
    ...d,
    rows: d.rows.map((r) => (r.app !== app || !r.configurable || !r.enabled ? r : {
      ...r, companyRequiresShift: requires,
    })),
  };
}

export function canSaveCompanyAppSettings(d: CompanyAppSettingsDraft): boolean {
  return d.state !== 'invalid';
}

/**
 * The `appConfiguration` payload, or null when nothing should be sent.
 *
 * Null means "do not call the callable at all" — omission is expressed by
 * not writing, since the backend has no field delete and this section must
 * never turn absence into `{}` by itself. Only NARROWING entries are
 * emitted: an enabled app with no company gate states nothing, so it is
 * left out entirely and the stored map says only what was decided.
 */
export function companyAppConfigurationPayload(
  d: CompanyAppSettingsDraft,
): CompanyAppConfigurations | null {
  if (d.state !== 'configured') return null;
  const out: CompanyAppConfigurations = {};
  for (const r of d.rows) {
    if (!r.configurable || isCoreApp(r.app)) continue;
    if (!r.enabled) out[r.app] = { enabled: false };
    else if (r.companyRequiresShift) out[r.app] = { requiresActiveShift: true };
  }
  return out;
}

/** Local pre-flight with the canonical validator. The backend still decides. */
export function validateCompanyDraft(
  d: CompanyAppSettingsDraft,
): { ok: true } | { ok: false; reason: string } {
  if (d.state === 'invalid') return { ok: false, reason: d.invalidReason ?? 'invalid' };
  const payload = companyAppConfigurationPayload(d);
  if (payload === null) return { ok: true };
  const v = validateCompanyAppConfigurations(payload);
  return v.ok ? { ok: true } : { ok: false, reason: v.key ? `${v.rejection}: ${v.key}` : v.rejection };
}

/** Core apps are shown, never configured. */
export const CORE_APPS = WELLBUILT_APP_KEYS.filter((k) => isCoreApp(k));
