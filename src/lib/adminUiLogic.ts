/**
 * vc51.9A7 — pure view-model logic for the verified-admin UI.
 *
 * NO React, NO firebase imports, NO I/O: every function here is driven
 * by tools/test-adminSession.mjs + tools/test-adminUiLogic.mjs with
 * plain data. Components stay thin renderers over these results.
 *
 * Only type-level imports from the service core (erased at runtime) and
 * the canonical @tester3x/wellbuilt-contracts resolver for the derived-schedule
 * example — the resolver IS the shared computation, not a competing
 * one. Effective capabilities always come from the
 * adminPreviewCompanyEffectiveCapabilities callable, never computed
 * here.
 */

import { resolveWorkPeriod, type WorkPeriodResolution } from '@tester3x/wellbuilt-contracts';
import type {
  AdminServiceErrorKind,
  CapabilityResult,
  CompanyContractStateLabel,
  EntitlementOverride,
  PlanCapability,
  StoredWorkPeriodConfiguration,
  WellbuiltContract,
} from './adminContractServiceCore';

// ── Part 2: verified-admin session state machine ─────────────────────────

export type AdminSessionStatus =
  | 'verifying'            // token/claims still resolving
  | 'signed_out'           // no authenticated user
  | 'ordinary'             // authenticated, no wellbuiltAdmin claim
  | 'verified'             // strict claim true — display gate ONLY
  | 'record_disabled'      // claim present but server record denies
  | 'incompatible_policy'  // server: unsupported admin policy version
  | 'refresh_failed';      // deliberate token refresh failed

export interface AdminSessionState {
  status: AdminSessionStatus;
  detail?: string;
}

/** Strict claim check — mirrors adminClaim.ts; truthy strings never pass. */
export function sessionFromClaims(
  signedIn: boolean,
  claims: Record<string, unknown> | null | undefined,
): AdminSessionState {
  if (!signedIn) return { status: 'signed_out' };
  return claims?.wellbuiltAdmin === true ? { status: 'verified' } : { status: 'ordinary' };
}

/**
 * Fold a protected-call failure into the session. The server stays
 * authoritative: a 'verified' display state demotes the moment the
 * backend denies. Non-authority errors leave the session untouched.
 */
export function sessionAfterServiceError(
  current: AdminSessionState,
  err: { kind: AdminServiceErrorKind; adminCode?: string | null },
): AdminSessionState {
  if (err.kind === 'unauthenticated') return { status: 'signed_out' };
  if (err.kind === 'missing_claim') return { status: 'ordinary', detail: err.adminCode ?? undefined };
  if (err.kind === 'disabled_admin') {
    return err.adminCode === 'unsupported_policy_version'
      ? { status: 'incompatible_policy', detail: err.adminCode }
      : { status: 'record_disabled', detail: err.adminCode ?? undefined };
  }
  return current;
}

/**
 * ONE deliberate verification pass (no loops, no polling):
 *   1. read claims (optionally forcing a token refresh);
 *   2. if the strict claim holds, confirm server authority with a
 *      single bounded probe (a protected read) so "claim present but
 *      record disabled" is honest instead of silently broken later.
 */
export async function verifyAdminSession(deps: {
  signedIn: boolean;
  getClaims: (forceRefresh: boolean) => Promise<Record<string, unknown> | null>;
  probe: () => Promise<void>;
}, opts: { forceRefresh?: boolean } = {}): Promise<AdminSessionState> {
  if (!deps.signedIn) return { status: 'signed_out' };
  let claims: Record<string, unknown> | null;
  try {
    claims = await deps.getClaims(opts.forceRefresh === true);
  } catch {
    return { status: 'refresh_failed' };
  }
  const fromClaims = sessionFromClaims(true, claims);
  if (fromClaims.status !== 'verified') return fromClaims;
  try {
    await deps.probe();
    return { status: 'verified' };
  } catch (err) {
    return sessionAfterServiceError(
      { status: 'verified' },
      err as { kind: AdminServiceErrorKind; adminCode?: string | null },
    );
  }
}

/** Honest bounded copy per session state — never a silent fallback. */
export function sessionMessage(state: AdminSessionState): { title: string; body: string; showRefresh: boolean } {
  switch (state.status) {
    case 'verifying':
      return { title: 'Verifying administrator access…', body: 'Checking your current session token.', showRefresh: false };
    case 'signed_out':
      return { title: 'Sign in required', body: 'Sign in to the Dashboard to continue.', showRefresh: false };
    case 'ordinary':
      return {
        title: 'Administrator access not active in this session',
        body: 'Your session token does not carry platform-administrator access. If access was granted recently, refresh administrator access — no sign-out is needed. Company roles (including viewAdmin) do not unlock this area.',
        showRefresh: true,
      };
    case 'record_disabled':
      return {
        title: 'Administrator record disabled',
        body: 'Your administrator record has been disabled on the server, so protected operations are denied. Contact another enabled platform administrator.',
        showRefresh: false,
      };
    case 'incompatible_policy':
      return {
        title: 'Administrator policy version not supported',
        body: 'The server requires a newer admin policy than this session supports. Update the Dashboard before retrying.',
        showRefresh: false,
      };
    case 'refresh_failed':
      return {
        title: 'Could not refresh administrator access',
        body: 'The token refresh failed. Check connectivity and try again — the previous session state is unchanged.',
        showRefresh: true,
      };
    case 'verified':
      return { title: 'Verified administrator', body: 'Protected operations remain server-authorized on every call.', showRefresh: false };
  }
}

// ── Part 12: normalized error → recovery guidance ────────────────────────

export interface ErrorGuidance {
  message: string;
  action: 'refresh-access' | 'contact-admin' | 'upgrade-required' | 'fix-fields' | 'reload' | 'retry' | 'sign-in' | 'diagnostic';
  retryable: boolean;
}

export function errorGuidance(err: { kind: AdminServiceErrorKind; adminCode?: string | null }): ErrorGuidance {
  switch (err.kind) {
    case 'unauthenticated':
      return { message: 'Your session has ended. Sign in again.', action: 'sign-in', retryable: false };
    case 'missing_claim':
      return { message: 'Administrator access is not active in this session. Use “Refresh administrator access”.', action: 'refresh-access', retryable: false };
    case 'disabled_admin':
      return { message: 'This administrator account is disabled on the server. Contact another enabled platform administrator.', action: 'contact-admin', retryable: false };
    case 'incompatible_contract':
      return { message: 'The stored contract is not supported by this version — an upgrade is required before this operation.', action: 'upgrade-required', retryable: false };
    case 'validation':
      return { message: describeValidation(err.adminCode), action: 'fix-fields', retryable: false };
    case 'not_found':
      return { message: 'The target no longer exists. Reload the current state.', action: 'reload', retryable: false };
    case 'conflict':
      return { message: 'This already exists or changed underneath you. Reload the current state before retrying.', action: 'reload', retryable: false };
    case 'retryable':
      return { message: 'The service is temporarily unavailable. It is safe to retry.', action: 'retry', retryable: true };
    case 'unknown':
      return { message: `Unexpected failure${err.adminCode ? ` (ref: ${err.adminCode})` : ''}. Report this reference — no data was changed unless stated.`, action: 'diagnostic', retryable: false };
  }
}

function describeValidation(adminCode: string | null | undefined): string {
  if (!adminCode) return 'The request was rejected by validation.';
  if (adminCode.startsWith('unknown_fields:')) return `Unexpected fields: ${adminCode.slice('unknown_fields:'.length)}`;
  if (adminCode.startsWith('missing_field:')) return `Required field missing: ${adminCode.slice('missing_field:'.length)}`;
  if (adminCode.startsWith('protected_field:')) return 'That field is contract-protected and can only change through a protected operation.';
  if (adminCode === 'plan_deprecated') return 'That plan is deprecated. Assigning it requires the explicit migration override.';
  if (adminCode.startsWith('incomplete_configuration:')) return 'The work-period configuration is incomplete for this mode.';
  return `Rejected: ${adminCode}`;
}

// ── Part 4: plan form validation ─────────────────────────────────────────

export const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PLAN_CAPABILITY_OPTIONS: ReadonlyArray<{ id: PlanCapability; label: string; customerConfigurable: string }> = Object.freeze([
  { id: 'jsa', label: 'JSA (Job Safety Analysis)', customerConfigurable: 'JSA mode & job policy' },
  { id: 'dvir', label: 'DVIR (eQuipment inspections)', customerConfigurable: 'none' },
  { id: 'explicitShiftLifecycle', label: 'Explicit shift lifecycle (WB-S Start Shift)', customerConfigurable: 'none' },
  { id: 'companyDefinedWorkPeriod', label: 'Company-defined work period', customerConfigurable: 'timezone, start time, duration' },
  { id: 'dispatch', label: 'Dispatch', customerConfigurable: 'dispatch options' },
  { id: 'billing', label: 'Billing', customerConfigurable: 'billing configuration' },
]);

export interface PlanFormErrors { planId?: string; displayName?: string; capabilities?: string }

export function validatePlanForm(input: {
  planId: string; displayName: string; capabilities: string[]; isEdit: boolean;
}): { ok: boolean; errors: PlanFormErrors } {
  const errors: PlanFormErrors = {};
  if (!input.isEdit && !PLAN_ID_RE.test(input.planId)) {
    errors.planId = 'Plan ID must be lowercase letters/digits/hyphens (max 64) and is permanent.';
  }
  if (!input.displayName.trim() || input.displayName.length > 100) {
    errors.displayName = 'Display name is required (max 100 characters). Changing it never changes the plan ID.';
  }
  const known = new Set(PLAN_CAPABILITY_OPTIONS.map((c) => c.id as string));
  if (input.capabilities.some((c) => !known.has(c)) || new Set(input.capabilities).size !== input.capabilities.length) {
    errors.capabilities = 'Unknown or duplicate capability selection.';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// ── Part 5: contract state labels ────────────────────────────────────────

export function contractStateView(state: CompanyContractStateLabel, invalidReason?: string): {
  label: string; tone: 'neutral' | 'info' | 'active' | 'danger'; description: string;
} {
  switch (state) {
    case 'legacy':
      return { label: 'Legacy (no contract)', tone: 'neutral', description: 'No WellBuilt contract is configured. The legacy tier badge is display-only and NOT authoritative.' };
    case 'inert':
      return { label: 'Configured — inert', tone: 'info', description: 'A contract is assigned but NOT enforced. Operational apps are unaffected until enforcement is deliberately enabled.' };
    case 'active':
      return { label: 'Active — enforced', tone: 'active', description: 'The contract is enforced. Operational apps follow its entitlements and work-period policy.' };
    case 'invalid':
      return { label: 'Invalid — upgrade required', tone: 'danger', description: `The stored contract cannot be used by this version${invalidReason ? ` (${invalidReason})` : ''}. It never falls back to legacy behavior; resolve before any contract operation.` };
  }
}

// ── Part 6: override display ─────────────────────────────────────────────

export function overrideView(o: EntitlementOverride, nowMs: number): {
  capability: PlanCapability; effect: string; expired: boolean; expiresText: string;
  actorText: string; reason: string;
} {
  const expired = !!o.expiresAt && Date.parse(o.expiresAt) <= nowMs;
  return {
    capability: o.capability,
    effect: o.granted ? 'grants' : 'revokes',
    expired,
    expiresText: o.expiresAt ? `${expired ? 'expired' : 'expires'} ${new Date(o.expiresAt).toLocaleString()}` : 'no expiry',
    actorText: `by ${o.grantedBy} at ${new Date(o.grantedAt).toLocaleString()} (server-verified)`,
    reason: o.reason,
  };
}

// ── Parts 7+9: work-period + effective-policy plain language ─────────────

export const LOGIN_VS_SHIFT_COPY =
  'Signing into WellBuilt does not automatically start a shift. Only configured operational workflows require an active work period.';

export interface PolicyLine { label: string; value: string; tone: 'neutral' | 'info' | 'active' | 'warn' | 'danger' }

/** Plain-language rendering of the CALLABLE preview — never recomputed. */
export function describeEffectivePreview(res: {
  state: CompanyContractStateLabel;
  result?: CapabilityResult;
  invalidReason?: string;
  contract?: WellbuiltContract | null;
}, nowMs: number): PolicyLine[] {
  if (res.state === 'legacy') {
    return [{ label: 'Contract', value: 'Legacy company — no contract assigned; no policy computed.', tone: 'neutral' }];
  }
  if (res.state === 'invalid') {
    return [{ label: 'Contract', value: `Upgrade required — ${res.invalidReason ?? 'stored contract unsupported'}.`, tone: 'danger' }];
  }
  const lines: PolicyLine[] = [
    { label: 'Contract state', value: res.state === 'active' ? 'Active (enforced)' : 'Configured, inert (not enforced)', tone: res.state === 'active' ? 'active' : 'info' },
  ];
  const r = res.result;
  if (!r) return [...lines, { label: 'Preview', value: 'No preview returned.', tone: 'warn' }];
  if (!r.ok) {
    return [...lines, {
      label: 'Preview', tone: 'danger',
      value: r.code === 'unsupported_contract_version'
        ? `Upgrade required — ${r.detail}`
        : `Cannot compute effective policy: ${r.code} — ${r.detail}`,
    }];
  }
  const caps = r.capabilities;
  const explicit = caps.workPeriodMode === 'explicit_shift';
  lines.push(
    { label: 'Suite login', value: caps.suiteLoginRequired ? 'Required — everyone signs in to use WellBuilt apps.' : 'Not required.', tone: 'info' },
    { label: 'WB-M ordinary use', value: 'No work period required — signing in is enough.', tone: 'neutral' },
    {
      label: 'WB-T job start',
      value: caps.explicitShiftRequiredBeforeJobs
        ? 'Requires an ACTIVE explicit shift (started in WB-S).'
        : explicit ? 'No explicit shift required before jobs under this plan.' : 'Bound to the company-defined work period.',
      tone: 'warn',
    },
    { label: 'WB-JSA request', value: 'Binds to the exact period of the invoking WB-T job.', tone: 'warn' },
    { label: 'eQuipment DVIR', value: explicit ? 'Binds to the exact invoking WB-S shift.' : 'Binds to the invoking work period.', tone: 'warn' },
    { label: 'JSA', value: caps.jsaEnabled ? 'Enabled' : 'Not enabled', tone: caps.jsaEnabled ? 'active' : 'neutral' },
    { label: 'DVIR', value: caps.dvirEnabled ? 'Enabled' : 'Not enabled', tone: caps.dvirEnabled ? 'active' : 'neutral' },
    { label: 'Work-period mode', value: explicit ? 'Explicit shift (WB-S Start Shift)' : 'Company-defined period', tone: 'info' },
  );
  const cfg = res.contract?.workPeriodConfiguration;
  if (cfg) {
    lines.push({
      label: 'Timezone / schedule',
      value: explicit
        ? `${cfg.timezone ?? 'America/Chicago'} — no derived schedule in explicit mode.`
        : `${cfg.timezone ?? '(timezone missing)'} — starts ${cfg.startLocalTime ?? '?'} local, ${cfg.durationMinutes ?? '?'} minutes.`,
      tone: 'neutral',
    });
  }
  const overrides = res.contract?.entitlementOverrides ?? [];
  for (const o of overrides) {
    const v = overrideView(o, nowMs);
    lines.push({
      label: `Override: ${v.capability}`,
      value: `${v.effect} the capability — ${v.expiresText}${v.expired ? ' (no longer applied)' : ''}`,
      tone: v.expired ? 'neutral' : 'warn',
    });
  }
  if (r.planDeprecated) {
    lines.push({ label: 'Plan', value: 'Assigned plan is DEPRECATED — existing behavior continues, but new assignments are blocked.', tone: 'warn' });
  }
  if (res.contract) {
    lines.push({ label: 'Versions', value: `contract v${res.contract.contractVersion}, configuration v${res.contract.configurationVersion}`, tone: 'neutral' });
  }
  return lines;
}

/** Explicit-mode affected-actions copy for WorkPeriodCard. */
export const EXPLICIT_MODE_ACTIONS: ReadonlyArray<{ action: string; requirement: string }> = Object.freeze([
  { action: 'WB-M app use', requirement: 'No work period required — ordinary sign-in only.' },
  { action: 'WB-T job start', requirement: 'Requires an active explicit shift started in WB-S.' },
  { action: 'WB-JSA request', requirement: 'Requires the exact period of the invoking WB-T job.' },
  { action: 'eQuipment DVIR', requirement: 'Requires the exact invoking WB-S shift.' },
]);

/**
 * Derived-schedule example computed by the CANONICAL resolver (DST-aware
 * by construction — the resolver resolves local wall time against the
 * zone's real offset, so a spring-forward start resolves past the gap).
 * Returns typed failure for invalid schedules — the card blocks submit.
 */
export function derivedScheduleExample(
  cfg: StoredWorkPeriodConfiguration,
  nowMs: number,
): { ok: true; current: { startIso: string; endIso: string } | null; next: { startIso: string; endIso: string } | null }
  | { ok: false; reason: string } {
  const resolveAt = (ms: number): WorkPeriodResolution => resolveWorkPeriod({
    contractVersion: 1,
    companyId: 'preview', driverId: 'preview',
    capabilities: {
      contractVersion: 1, companyId: 'preview', suiteLoginRequired: true,
      workPeriodMode: 'company_defined_period', explicitShiftRequiredBeforeJobs: false,
      jsaEnabled: false, dvirEnabled: false, customerEditableFields: [],
    },
    config: {
      contractVersion: 1, configurationVersion: 1, mode: 'company_defined_period',
      timezone: cfg.timezone, startLocalTime: cfg.startLocalTime, durationMinutes: cfg.durationMinutes,
    },
    nowMs: ms,
  });
  const now = resolveAt(nowMs);
  if (now.outcome === 'INVALID_CONFIGURATION') return { ok: false, reason: now.reason };
  const current = now.outcome === 'CURRENT_DERIVED_PERIOD'
    ? { startIso: now.startIso as string, endIso: now.endIso as string }
    : null;
  // Probe forward hourly (max 30h) from the current end / now for the next
  // period — the resolver, not local math, decides every boundary (DST safe).
  const searchFrom = current ? Date.parse(current.endIso) : nowMs;
  for (let h = 0; h <= 30; h++) {
    const probe = resolveAt(searchFrom + h * 3600_000 + 60_000);
    if (probe.outcome === 'CURRENT_DERIVED_PERIOD' && probe.startIso !== current?.startIso) {
      return { ok: true, current, next: { startIso: probe.startIso as string, endIso: probe.endIso as string } };
    }
  }
  return { ok: true, current, next: null };
}

export function isOvernight(cfg: StoredWorkPeriodConfiguration): boolean {
  if (!cfg.startLocalTime || typeof cfg.durationMinutes !== 'number') return false;
  const [h, m] = cfg.startLocalTime.split(':').map(Number);
  return h * 60 + m + cfg.durationMinutes > 24 * 60;
}

// ── Part 8: enforcement preconditions ────────────────────────────────────

export function enforcementReadiness(input: {
  state: CompanyContractStateLabel;
  contract?: WellbuiltContract | null;
  preview?: CapabilityResult | null;
}): { canEnable: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (input.state === 'legacy') blockers.push('No plan assigned — assign a plan first.');
  if (input.state === 'invalid') blockers.push('Stored contract is invalid/upgrade-required.');
  if (input.state === 'active') blockers.push('Contract is already enforced.');
  const cfg = input.contract?.workPeriodConfiguration;
  if (input.state === 'inert') {
    if (!cfg) blockers.push('Work-period configuration is missing.');
    else if (cfg.mode === 'company_defined_period' && (!cfg.timezone || !cfg.startLocalTime || typeof cfg.durationMinutes !== 'number')) {
      blockers.push('Company-defined period configuration is incomplete (timezone, start time, duration).');
    }
    if (!input.preview) blockers.push('Effective-policy preview has not been computed.');
    else if (!input.preview.ok) blockers.push(`Effective capabilities cannot be computed: ${input.preview.code}.`);
  }
  return { canEnable: input.state === 'inert' && blockers.length === 0, blockers };
}

export const ENFORCEMENT_WARNING =
  'Enforcing this contract changes how operational apps behave for this company. Every required installed app must be compatible before activation — enable only after rollout verification. Disabling enforcement remains available as rollback containment.';

// ── Part 10: safe mutation routing ───────────────────────────────────────

/** Which mutation path a company action must take, by contract state. */
export function companyMutationRoute(state: CompanyContractStateLabel): {
  edit: 'safe-callable'; delete: 'archive-callable' | 'legacy-client-delete';
  deleteWarning: string;
} {
  const configured = state !== 'legacy';
  return {
    edit: 'safe-callable',
    delete: configured ? 'archive-callable' : 'legacy-client-delete',
    deleteWarning: configured
      ? 'Configured companies cannot be hard-deleted. Archive preserves the contract and all data.'
      : 'Legacy delete removes ONLY the company document — subcollections (SWD directory, equipment, counters) are orphaned, not deleted. Prefer archiving.',
  };
}
