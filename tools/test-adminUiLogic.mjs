/**
 * vc51.9A7 — admin UI view-model matrix (Part 14): plans validation,
 * contract states, override display, effective-policy plain language,
 * work-period derived/overnight/DST examples, enforcement readiness,
 * safe-mutation routing, error guidance. Pure data in, pure data out.
 *
 * Run: node --experimental-strip-types tools/test-adminUiLogic.mjs
 */
import {
  ENFORCEMENT_WARNING, EXPLICIT_MODE_ACTIONS, LOGIN_VS_SHIFT_COPY, PLAN_ID_RE,
  companyMutationRoute, contractStateView, derivedScheduleExample,
  describeEffectivePreview, enforcementReadiness, errorGuidance, isOvernight,
  overrideView, validatePlanForm,
} from '../src/lib/adminUiLogic.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const NOW = Date.parse('2026-08-06T15:00:00.000Z');

// ── Plans (validation + identity) ─────────────────────────────────────────
check('valid create form passes',
  validatePlanForm({ planId: 'plan-field', displayName: 'Field', capabilities: ['jsa'], isEdit: false }).ok);
check('invalid planId rejected with permanence copy',
  validatePlanForm({ planId: 'Bad!', displayName: 'X', capabilities: [], isEdit: false }).errors.planId.includes('permanent'));
check('edit form ignores planId (immutable identifier)',
  validatePlanForm({ planId: 'IGNORED IN EDIT', displayName: 'X', capabilities: [], isEdit: true }).ok);
check('display-name rule states it never changes the planId',
  validatePlanForm({ planId: 'p', displayName: '', capabilities: [], isEdit: true }).errors.displayName.includes('never changes the plan ID'));
check('duplicate capability rejected',
  !validatePlanForm({ planId: 'p-1', displayName: 'X', capabilities: ['jsa', 'jsa'], isEdit: false }).ok);
check('unknown capability rejected',
  !validatePlanForm({ planId: 'p-1', displayName: 'X', capabilities: ['root'], isEdit: false }).ok);
{
  // PLAN_ID_RE cannot drift from the Functions-side validator.
  const fnSrc = readFileSync(join(root, 'functions/src/admin/companyContract.ts'), 'utf8');
  const fnRe = fnSrc.match(/PLAN_ID_RE = (\/[^/]+\/)/)?.[1];
  check('client PLAN_ID_RE matches Functions validator', fnRe === String(PLAN_ID_RE), `fn=${fnRe} ui=${PLAN_ID_RE}`);
}

// ── Contract states ───────────────────────────────────────────────────────
check('legacy state marks tier non-authoritative',
  contractStateView('legacy').description.includes('NOT authoritative'));
check('inert state says apps unaffected until enforcement',
  contractStateView('inert').description.includes('until enforcement'));
check('invalid state is upgrade-required, never legacy fallback',
  contractStateView('invalid', 'unsupported_contract_version:99').label.includes('upgrade required')
  && contractStateView('invalid').description.includes('never falls back'));

// ── Overrides ─────────────────────────────────────────────────────────────
const ovr = (extra = {}) => ({
  capability: 'jsa', granted: false, reason: 'trial over', grantedBy: 'admin-1',
  grantedAt: '2026-08-01T00:00:00.000Z', ...extra,
});
check('active override shows verified actor and effect',
  overrideView(ovr(), NOW).effect === 'revokes' && overrideView(ovr(), NOW).actorText.includes('server-verified'));
check('expired override clearly marked and de-emphasized',
  overrideView(ovr({ expiresAt: '2026-08-02T00:00:00.000Z' }), NOW).expired === true);
check('unexpired future expiry not marked expired',
  overrideView(ovr({ expiresAt: '2026-09-01T00:00:00.000Z' }), NOW).expired === false);

// ── Effective preview plain language ─────────────────────────────────────
const CONTRACT = {
  contractVersion: 1, configurationVersion: 3, planId: 'plan-field',
  entitlementOverrides: [ovr({ expiresAt: '2026-08-02T00:00:00.000Z' })],
  workPeriodConfiguration: { mode: 'explicit_shift', timezone: 'America/Chicago' },
  contractEnforced: false,
};
const CAPS_OK = {
  ok: true, planDeprecated: true, overrideAdjusted: [],
  capabilities: {
    contractVersion: 1, companyId: 'liquid-gold', suiteLoginRequired: true,
    workPeriodMode: 'explicit_shift', explicitShiftRequiredBeforeJobs: true,
    jsaEnabled: true, dvirEnabled: true, customerEditableFields: [],
  },
};
{
  const lines = describeEffectivePreview({ state: 'inert', result: CAPS_OK, contract: CONTRACT }, NOW);
  const text = lines.map((l) => `${l.label}: ${l.value}`).join('\n');
  check('preview: suite login required line', text.includes('Suite login: Required'));
  check('preview: WB-M needs no period', text.includes('WB-M ordinary use: No work period required'));
  check('preview: WB-T requires ACTIVE explicit shift', text.includes('ACTIVE explicit shift'));
  check('preview: JSA binds to invoking job period', text.includes('invoking WB-T job'));
  check('preview: DVIR binds to invoking shift', text.includes('invoking WB-S shift'));
  check('preview: JSA/DVIR enabled lines', text.includes('JSA: Enabled') && text.includes('DVIR: Enabled'));
  check('preview: mode + timezone shown', text.includes('Explicit shift') && text.includes('America/Chicago'));
  check('preview: expired override annotated', text.includes('no longer applied'));
  check('preview: deprecated plan warning', text.includes('DEPRECATED'));
  check('preview: contract/configuration versions', text.includes('contract v1, configuration v3'));
}
check('preview: legacy renders no computed policy',
  describeEffectivePreview({ state: 'legacy' }, NOW)[0].value.includes('no contract'));
check('preview: invalid renders upgrade-required',
  describeEffectivePreview({ state: 'invalid', invalidReason: 'unsupported_contract_version:99' }, NOW)[0].tone === 'danger');
check('preview: uncomputable result surfaces failure code',
  describeEffectivePreview({ state: 'inert', result: { ok: false, code: 'mode_not_entitled', detail: 'x' }, contract: CONTRACT }, NOW)
    .some((l) => l.value.includes('mode_not_entitled')));

// ── Work period (Part 7) ─────────────────────────────────────────────────
check('login-vs-shift copy is exactly the required distinction',
  LOGIN_VS_SHIFT_COPY === 'Signing into WellBuilt does not automatically start a shift. Only configured operational workflows require an active work period.');
check('explicit-mode actions cover WB-M/WB-T/JSA/DVIR',
  EXPLICIT_MODE_ACTIONS.length === 4 && EXPLICIT_MODE_ACTIONS[0].requirement.includes('No work period'));
{
  const cfg = { mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '06:00', durationMinutes: 720 };
  const ex = derivedScheduleExample(cfg, Date.parse('2026-08-06T16:00:00.000Z')); // 11:00 local
  check('derived: current period computed by canonical resolver',
    ex.ok && ex.current !== null && ex.current.startIso === '2026-08-06T11:00:00.000Z');
  check('derived: next period example computed',
    ex.ok && ex.next !== null && ex.next.startIso === '2026-08-07T11:00:00.000Z');
}
{
  const overnight = { mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '18:00', durationMinutes: 720 };
  check('overnight schedule detected', isOvernight(overnight) === true);
  const ex = derivedScheduleExample(overnight, Date.parse('2026-08-07T04:00:00.000Z')); // 23:00 local prev day
  check('overnight: period crosses midnight and still resolves',
    ex.ok && ex.current !== null && ex.current.startIso === '2026-08-06T23:00:00.000Z');
}
{
  // DST spring-forward 2026-03-08 in America/Chicago: offsets differ
  // across the boundary — the resolver, not local math, sets both ends.
  const cfg = { mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '06:00', durationMinutes: 720 };
  const before = derivedScheduleExample(cfg, Date.parse('2026-03-07T13:00:00.000Z'));
  const after = derivedScheduleExample(cfg, Date.parse('2026-03-09T13:00:00.000Z'));
  check('DST: local 06:00 start maps to different UTC offsets across the change',
    before.ok && after.ok
    && before.current.startIso === '2026-03-07T12:00:00.000Z'   // CST (UTC-6)
    && after.current.startIso === '2026-03-09T11:00:00.000Z');  // CDT (UTC-5)
}
check('invalid timezone cannot submit',
  derivedScheduleExample({ mode: 'company_defined_period', timezone: 'Mars/Olympus', startLocalTime: '06:00', durationMinutes: 720 }, NOW).ok === false);
check('invalid schedule (missing duration) cannot submit',
  derivedScheduleExample({ mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '06:00' }, NOW).ok === false);

// ── Enforcement readiness (Part 8) ───────────────────────────────────────
check('legacy company blocked from enforcement',
  !enforcementReadiness({ state: 'legacy' }).canEnable);
check('invalid contract blocked from enforcement',
  enforcementReadiness({ state: 'invalid' }).blockers.some((b) => b.includes('invalid')));
check('incomplete derived configuration blocked',
  enforcementReadiness({
    state: 'inert',
    contract: { ...CONTRACT, workPeriodConfiguration: { mode: 'company_defined_period' } },
    preview: CAPS_OK,
  }).blockers.some((b) => b.includes('incomplete')));
check('uncomputable preview blocked',
  enforcementReadiness({ state: 'inert', contract: CONTRACT, preview: { ok: false, code: 'mode_not_entitled', detail: 'x' } })
    .blockers.some((b) => b.includes('mode_not_entitled')));
check('complete + computable inert contract can enable',
  enforcementReadiness({ state: 'inert', contract: CONTRACT, preview: CAPS_OK }).canEnable === true);
check('already-active contract cannot re-enable',
  !enforcementReadiness({ state: 'active', contract: CONTRACT, preview: CAPS_OK }).canEnable);
check('enforcement warning covers apps/compatibility/rollback',
  ENFORCEMENT_WARNING.includes('operational apps') && ENFORCEMENT_WARNING.includes('compatible')
  && ENFORCEMENT_WARNING.includes('rollback containment'));

// ── Safe mutation routing (Part 10) ──────────────────────────────────────
check('configured company delete routes to archive callable',
  companyMutationRoute('inert').delete === 'archive-callable'
  && companyMutationRoute('active').delete === 'archive-callable'
  && companyMutationRoute('invalid').delete === 'archive-callable');
check('legacy company keeps labeled client delete with orphan warning',
  companyMutationRoute('legacy').delete === 'legacy-client-delete'
  && companyMutationRoute('legacy').deleteWarning.includes('orphaned'));
check('all edits route through the safe callable',
  companyMutationRoute('legacy').edit === 'safe-callable');

// ── Error guidance (Part 12) ─────────────────────────────────────────────
const g = (kind, adminCode) => errorGuidance({ kind, adminCode });
check('missing claim → refresh-access guidance', g('missing_claim').action === 'refresh-access');
check('disabled admin → contact another enabled admin', g('disabled_admin').message.includes('another enabled platform administrator'));
check('incompatible contract → upgrade required', g('incompatible_contract').action === 'upgrade-required');
check('validation → field-level feedback', g('validation', 'missing_field:planId').message.includes('planId'));
check('conflict → reload current state', g('conflict').action === 'reload');
check('retryable → safe retry, others never retry',
  g('retryable').retryable === true && g('unknown').retryable === false && g('validation').retryable === false);
check('unknown → bounded diagnostic reference, no payload', g('unknown', 'ref-123').message.includes('ref-123'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
