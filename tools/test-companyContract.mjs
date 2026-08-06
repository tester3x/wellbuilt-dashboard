/**
 * vc51.9A6-B — nested wellbuiltContract parsing + effective-capability
 * computation matrix. Imports the COMPILED functions output, so run
 * `npm --prefix functions run build` first (verification does).
 *
 * Run: node tools/test-companyContract.mjs
 */
import {
  parseCompanyContract, isWorkPeriodConfigurationComplete,
  toContractsWorkPeriodConfiguration, PLAN_CAPABILITIES,
} from '../functions/lib/admin/companyContract.js';
import { computeEffectiveCapabilities } from '../functions/lib/admin/effectiveCapabilities.js';
import { requiresWorkPeriod, resolveWorkPeriod, CONTRACT_VERSION } from '@tester3x/wellbuilt-contracts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const NOW = Date.parse('2026-08-06T15:00:00.000Z');
const baseContract = (extra = {}) => ({
  contractVersion: 1, configurationVersion: 1, planId: 'plan-field',
  entitlementOverrides: [],
  workPeriodConfiguration: { mode: 'explicit_shift' },
  contractEnforced: false, ...extra,
});
const plan = (extra = {}) => ({
  contractVersion: 1, planId: 'plan-field', displayName: 'Field',
  capabilities: ['jsa', 'dvir', 'explicitShiftLifecycle', 'dispatch'],
  status: 'active', ...extra,
});
const override = (extra = {}) => ({
  capability: 'jsa', granted: false, reason: 'trial ended',
  grantedBy: 'admin-uid', grantedAt: '2026-08-01T00:00:00.000Z', ...extra,
});

// ── Part 3: parsing states ────────────────────────────────────────────────
check('absent → legacy', parseCompanyContract(undefined).state === 'legacy');
check('null → invalid, never legacy', parseCompanyContract(null).state === 'invalid');
check('array → invalid', parseCompanyContract([]).state === 'invalid');
check('unknown key → invalid', parseCompanyContract(baseContract({ surprise: 1 })).state === 'invalid');
check('current shift state rejected (currentShiftId)',
  parseCompanyContract(baseContract({ currentShiftId: 's1' })).state === 'invalid');
check('persisted effectiveCapabilities rejected',
  parseCompanyContract(baseContract({ effectiveCapabilities: {} })).state === 'invalid');
check('client actor field rejected (updatedBy)',
  parseCompanyContract(baseContract({ updatedBy: 'x' })).state === 'invalid');
{
  const r = parseCompanyContract(baseContract({ contractVersion: 2 }));
  check('future contractVersion → invalid upgrade-required (not legacy)',
    r.state === 'invalid' && r.reason.startsWith('unsupported_contract_version'));
}
check('configurationVersion 0 → invalid',
  parseCompanyContract(baseContract({ configurationVersion: 0 })).state === 'invalid');
check('bad planId → invalid',
  parseCompanyContract(baseContract({ planId: 'Bad Plan!' })).state === 'invalid');
check('non-boolean contractEnforced → invalid',
  parseCompanyContract(baseContract({ contractEnforced: 'yes' })).state === 'invalid');
check('override with unknown capability → invalid',
  parseCompanyContract(baseContract({ entitlementOverrides: [override({ capability: 'root' })] })).state === 'invalid');
check('override with unbounded reason → invalid',
  parseCompanyContract(baseContract({ entitlementOverrides: [override({ reason: 'x'.repeat(301) })] })).state === 'invalid');
check('override with extra key → invalid',
  parseCompanyContract(baseContract({ entitlementOverrides: [override({ sneak: 1 })] })).state === 'invalid');
check('override with bad expiresAt → invalid',
  parseCompanyContract(baseContract({ entitlementOverrides: [override({ expiresAt: 'tomorrow' })] })).state === 'invalid');
check('work period bad timezone → invalid',
  parseCompanyContract(baseContract({ workPeriodConfiguration: { mode: 'company_defined_period', timezone: 'Mars/Olympus' } })).state === 'invalid');
check('work period bad time → invalid',
  parseCompanyContract(baseContract({ workPeriodConfiguration: { mode: 'company_defined_period', startLocalTime: '25:00' } })).state === 'invalid');
check('work period bad duration → invalid',
  parseCompanyContract(baseContract({ workPeriodConfiguration: { mode: 'company_defined_period', durationMinutes: 100000 } })).state === 'invalid');
check('valid + enforced:false → inert', parseCompanyContract(baseContract()).state === 'inert');
check('valid + enforced:true → active',
  parseCompanyContract(baseContract({ contractEnforced: true })).state === 'active');
check('workPeriodConfiguration optional (inert without it)',
  (() => { const c = baseContract(); delete c.workPeriodConfiguration; return parseCompanyContract(c).state === 'inert'; })());

// Completeness gate.
check('explicit mode is complete',
  isWorkPeriodConfigurationComplete({ mode: 'explicit_shift' }).complete === true);
check('derived mode incomplete without timezone',
  isWorkPeriodConfigurationComplete({ mode: 'company_defined_period', startLocalTime: '06:00', durationMinutes: 720 }).complete === false);
check('derived mode complete with tz+start+duration',
  isWorkPeriodConfigurationComplete({ mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '06:00', durationMinutes: 720 }).complete === true);
check('absent config is incomplete', isWorkPeriodConfigurationComplete(undefined).complete === false);

// Version injection (single source at the contract root).
{
  const parsed = parseCompanyContract(baseContract({ configurationVersion: 7 }));
  const full = toContractsWorkPeriodConfiguration(parsed.contract);
  check('materialized configuration injects root versions',
    full.contractVersion === CONTRACT_VERSION && full.configurationVersion === 7 && full.mode === 'explicit_shift');
}
check('capability list is the contracts union (6 entries)', PLAN_CAPABILITIES.length === 6);

// ── Part 4: effective-capability computation ──────────────────────────────
const compute = (contractExtra = {}, planExtra = {}, nowMs = NOW) =>
  computeEffectiveCapabilities({
    companyId: 'liquid-gold',
    plan: plan(planExtra),
    contract: parseCompanyContract(baseContract(contractExtra)).contract
      ?? baseContract(contractExtra), // invalid shapes passed raw on purpose
    nowMs,
  });

// no contract → callers handle legacy before this helper; helper contract-less
// path is "missing configuration" when config absent:
{
  const c = baseContract(); delete c.workPeriodConfiguration;
  const r = computeEffectiveCapabilities({ companyId: 'x', plan: plan(), contract: parseCompanyContract(c).contract, nowMs: NOW });
  check('missing work-period configuration → typed failure',
    r.ok === false && r.code === 'missing_work_period_configuration');
}
{
  const r = compute({ contractEnforced: false });
  check('inert contract still computes (preview before enforcement)',
    r.ok === true && r.capabilities.workPeriodMode === 'explicit_shift');
}
{
  const r = compute({ contractEnforced: true });
  check('active explicit contract: explicitShiftRequiredBeforeJobs true',
    r.ok === true && r.capabilities.explicitShiftRequiredBeforeJobs === true
    && r.capabilities.jsaEnabled === true && r.capabilities.dvirEnabled === true);
  check('suite login required — independent capability, never discarded (vc51.9A6-C)',
    r.ok === true && r.capabilities.suiteLoginRequired === true);
}
{
  const r = compute({
    workPeriodConfiguration: { mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '06:00', durationMinutes: 720 },
    entitlementOverrides: [override({ capability: 'companyDefinedWorkPeriod', granted: true, reason: 'derived pilot' })],
    contractEnforced: true,
  });
  check('active derived contract computes with customer-editable fields',
    r.ok === true && r.capabilities.workPeriodMode === 'company_defined_period'
    && r.capabilities.explicitShiftRequiredBeforeJobs === false
    && r.capabilities.customerEditableFields.length === 3);
}
{
  const r = compute({ workPeriodConfiguration: { mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '06:00', durationMinutes: 720 } });
  check('derived mode without entitlement → mode_not_entitled',
    r.ok === false && r.code === 'mode_not_entitled');
}
{
  const raw = baseContract({ workPeriodConfiguration: { mode: 'company_defined_period', timezone: 'Mars/Olympus', startLocalTime: '06:00', durationMinutes: 720 },
    entitlementOverrides: [override({ capability: 'companyDefinedWorkPeriod', granted: true, reason: 'x' })] });
  const r = computeEffectiveCapabilities({ companyId: 'x', plan: plan(), contract: raw, nowMs: NOW });
  check('malformed timezone (validated at compute too) → invalid_work_period_configuration',
    r.ok === false && r.code === 'invalid_work_period_configuration');
}
{
  const r = compute({ entitlementOverrides: [override({ expiresAt: '2026-08-01T00:00:00.000Z' })] });
  check('expired override ignored (jsa stays enabled)',
    r.ok === true && r.capabilities.jsaEnabled === true && r.overrideAdjusted.length === 0);
}
{
  const r = compute({ entitlementOverrides: [override()] });
  check('active revoking override applies (jsa disabled)',
    r.ok === true && r.capabilities.jsaEnabled === false && r.overrideAdjusted.includes('jsa'));
}
{
  const r = compute({ entitlementOverrides: [override(), override({ granted: true, reason: 're-granted' })] });
  check('conflicting overrides: last active entry wins (jsa re-enabled)',
    r.ok === true && r.capabilities.jsaEnabled === true);
}
{
  const r = compute({}, { status: 'deprecated' });
  check('deprecated plan still computes, flagged (no silent alteration)',
    r.ok === true && r.planDeprecated === true);
}
{
  const raw = baseContract(); raw.contractVersion = 99;
  const r = computeEffectiveCapabilities({ companyId: 'x', plan: plan(), contract: raw, nowMs: NOW });
  check('unsupported version → typed failure',
    r.ok === false && r.code === 'unsupported_contract_version');
}
{
  const r = compute({ planId: 'plan-other' });
  check('plan/contract mismatch → plan_mismatch',
    r.ok === false && r.code === 'plan_mismatch');
}

// ── Liquid Gold mixed workflow (the pinned behavior) ──────────────────────
// vc51.9A6-C required model — five distinctions, red-first:
//   suiteLoginRequired answers "must the user AUTHENTICATE to use the
//   suite"; requiresWorkPeriod answers "does THIS ACTION need a verified
//   period". Login true never implies Start Shift; NO_PERIOD_REQUIRED
//   never means login is unnecessary.
{
  const caps = compute({ contractEnforced: true }).capabilities;
  check('1. unauthenticated WB-M use is blocked by ordinary suite auth (suiteLoginRequired true)',
    caps.suiteLoginRequired === true);
  check('2. authenticated app_use allowed with NO_PERIOD_REQUIRED even though login is required',
    caps.suiteLoginRequired === true && requiresWorkPeriod(caps, 'app_use') === false);
  check('3. WB-T job start requires the verified explicit shift',
    requiresWorkPeriod(caps, 'wbt_job_start') === true);
  check('4. WB-JSA request requires the invoking period',
    requiresWorkPeriod(caps, 'jsa_request') === true);
  check('5. eQuipment DVIR requires the invoking shift',
    requiresWorkPeriod(caps, 'equipment_dvir') === true);
  check('login capability matches the package Liquid Gold fixture',
    caps.suiteLoginRequired === true && caps.workPeriodMode === 'explicit_shift'
    && caps.explicitShiftRequiredBeforeJobs === true);
}
{
  const caps = compute({ contractEnforced: true }).capabilities;
  check('app_use never requires a period (WB-M testers)',
    requiresWorkPeriod(caps, 'app_use') === false);
  check('wbt_job_start requires a period (Mike operational)',
    requiresWorkPeriod(caps, 'wbt_job_start') === true);
  check('jsa_request requires a period', requiresWorkPeriod(caps, 'jsa_request') === true);
  check('equipment_dvir requires a period', requiresWorkPeriod(caps, 'equipment_dvir') === true);

  const cfgFull = { contractVersion: 1, configurationVersion: 1, mode: 'explicit_shift' };
  const common = { contractVersion: 1, companyId: 'liquid-gold', driverId: 'mike', capabilities: caps, config: cfgFull, nowMs: NOW };
  const appUse = resolveWorkPeriod({ ...common, action: 'app_use' });
  check('resolver: app_use → NO_PERIOD_REQUIRED (login is not a shift)',
    appUse.outcome === 'NO_PERIOD_REQUIRED');
  const noEvidence = resolveWorkPeriod({ ...common, action: 'wbt_job_start' });
  check('resolver: wbt_job_start without evidence → UNVERIFIED_OFFLINE (fail closed)',
    noEvidence.outcome === 'UNVERIFIED_OFFLINE');
  const active = resolveWorkPeriod({
    ...common, action: 'wbt_job_start',
    evidence: { today: { readable: true, present: true, currentShiftId: 'shift-808' } },
  });
  check('resolver: wbt_job_start with authoritative open shift → ACTIVE_EXPLICIT_SHIFT',
    active.outcome === 'ACTIVE_EXPLICIT_SHIFT' && active.periodId === 'shift-808');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
