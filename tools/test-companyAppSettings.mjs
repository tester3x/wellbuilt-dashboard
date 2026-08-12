/**
 * vc51.9M — per-company app operation settings.
 *
 * Two boundaries are load-bearing. The PLAN is a ceiling: company settings
 * can narrow it and never widen it. And absence is a state: viewing a
 * company, opening the section, or cancelling must never turn a
 * never-configured contract into `{}`.
 *
 * Run: node tools/test-companyAppSettings.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planAppStatus,
  describeCompanyAppSettings,
  draftFromContract,
  beginConfiguringCompany,
  setCompanyAppEnabled,
  setCompanyAppRequiresShift,
  companyAppConfigurationPayload,
  validateCompanyDraft,
  canSaveCompanyAppSettings,
  DESTINATION_APPS,
  CORE_APPS,
} from '../src/lib/companyAppSettings.ts';
import {
  WELLBUILT_APP_TICKETS, WELLBUILT_APP_MOBILE, WELLBUILT_APP_SUITE,
  WELLBUILT_APP_EQUIPMENT, WELLBUILT_APP_DASHBOARD,
  validateCompanyAppConfigurations, decideAppAccessWithConfiguration, isCoreApp,
} from '@tester3x/wellbuilt-contracts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const T = WELLBUILT_APP_TICKETS, M = WELLBUILT_APP_MOBILE, S = WELLBUILT_APP_SUITE;
const plan = (apps) => {
  const p = { contractVersion: 1, planId: 'plan-1', displayName: 'P', capabilities: [], status: 'active' };
  if (apps !== undefined) p.apps = apps;
  return p;
};
const INCLUDED = plan({ [T]: { included: true }, [M]: { included: true } });
const GATED = plan({ [T]: { included: true, requiresActiveShift: true } });
const EXCLUDED = plan({ [T]: { included: false } });
const LEGACY = plan(undefined);
const BADPLAN = plan(null);

// ── plan status: the ceiling ──────────────────────────────────────────────
check('plan-included app reads as included', planAppStatus(INCLUDED, T).kind === 'included');
check('plan-mandated shift is reported as such',
  planAppStatus(GATED, T).kind === 'included' && planAppStatus(GATED, T).planMandatesShift === true);
check('plan-excluded app reads as excluded', planAppStatus(EXCLUDED, T).kind === 'excluded');
check('app absent from a present map reads as excluded',
  planAppStatus(plan({}), T).kind === 'excluded');
check('legacy plan reads as legacy', planAppStatus(LEGACY, T).kind === 'legacy');
check('invalid plan entitlement reads as invalid',
  planAppStatus(BADPLAN, T).kind === 'invalid');
check('a missing plan reads as legacy, not a crash', planAppStatus(null, T).kind === 'legacy');
check('Suite is core and is never a configurable row',
  CORE_APPS.length === 1 && CORE_APPS[0] === S && isCoreApp(S)
  && !DESTINATION_APPS.includes(S)
  && !draftFromContract(INCLUDED, undefined).rows.some((r) => r.app === S));

// ── display ───────────────────────────────────────────────────────────────
check('absent configuration shows the no-restrictions message', (() => {
  const d = describeCompanyAppSettings(undefined);
  return d.kind === 'absent' && /No company-specific app restrictions/i.test(d.label);
})());
check('{} shows CONFIGURED with no restrictions — distinct from absent', (() => {
  const d = describeCompanyAppSettings({});
  return d.kind === 'none' && /Configured/i.test(d.label);
})());
check('a company-disabled app is counted as restricted',
  describeCompanyAppSettings({ [M]: { enabled: false } }).restricted === 1);
check('a company shift gate is counted as restricted',
  describeCompanyAppSettings({ [T]: { requiresActiveShift: true } }).restricted === 1);
for (const [label, cfg] of [
  ['null', null], ['an array', []], ['a scalar', 3],
  ['an alias', { wbt: {} }], ['an unknown app', { 'wellbuilt-payroll': {} }],
  ['a broken entry', { [T]: 5 }],
  ['disabled + gated', { [T]: { enabled: false, requiresActiveShift: true } }],
  ['a Suite entry', { [S]: { enabled: false } }],
]) {
  const d = describeCompanyAppSettings(cfg);
  check(`malformed company configuration (${label}) shows the INVALID error`,
    d.kind === 'invalid' && /invalid/i.test(d.label));
  check(`  ${label} is never shown as absent or as {}`,
    d.kind !== 'absent' && d.kind !== 'none');
}

// ── the plan is a ceiling ─────────────────────────────────────────────────
check('an excluded app is not configurable', (() => {
  const row = draftFromContract(EXCLUDED, undefined).rows.find((r) => r.app === T);
  return row.configurable === false && row.plan.kind === 'excluded';
})());
check('a legacy-plan app is not configurable', (() => {
  const row = draftFromContract(LEGACY, undefined).rows.find((r) => r.app === T);
  return row.configurable === false;
})());
check('an invalid-plan app is not configurable',
  draftFromContract(BADPLAN, undefined).rows.find((r) => r.app === T).configurable === false);
check('toggling an EXCLUDED app is a no-op — configuration cannot widen', (() => {
  let d = beginConfiguringCompany(draftFromContract(EXCLUDED, undefined));
  d = setCompanyAppEnabled(d, T, true);
  d = setCompanyAppRequiresShift(d, T, true);
  const payload = companyAppConfigurationPayload(d);
  return !(T in payload);
})());
// ── plan gate and company gate are INDEPENDENTLY representable ────────────
// An earlier revision hid the company control whenever the plan mandated a
// shift, which forced a migration to drop the plan gate before the company
// gate could be set — a window with neither. Both must be expressible at
// once, even though enforcement is their OR.
{
  const rowOf = (d) => d.rows.find((r) => r.app === T);

  // plan true + company ABSENT → unchecked box, inherited indicator shown.
  const a = beginConfiguringCompany(draftFromContract(GATED, undefined));
  check('plan true + company absent: company box UNCHECKED, plan indicator shown',
    rowOf(a).companyRequiresShift === false && rowOf(a).planMandatesShift === true
    && rowOf(a).configurable === true);

  // plan true + company TRUE → checked box AND inherited indicator.
  const b = draftFromContract(GATED, { [T]: { requiresActiveShift: true } });
  check('plan true + company true: company box CHECKED, plan indicator still shown',
    rowOf(b).companyRequiresShift === true && rowOf(b).planMandatesShift === true);

  // Checking the company box while the plan gate is on emits an explicit
  // company flag — this is what makes the SAFE migration order possible.
  let c = beginConfiguringCompany(draftFromContract(GATED, undefined));
  c = setCompanyAppRequiresShift(c, T, true);
  const cPayload = companyAppConfigurationPayload(c);
  check('checking the company box while the plan gate is ON emits the company flag',
    cPayload[T].requiresActiveShift === true);
  check('  and the safe migration order now has no ungated window', (() => {
    // company gate written FIRST, plan gate dropped SECOND: every state gates.
    const planDropped = plan({ [T]: { included: true }, [M]: { included: true } });
    return [
      [GATED, undefined], [GATED, cPayload], [planDropped, cPayload],
    ].every(([p, cfg]) =>
      decideAppAccessWithConfiguration(p, cfg, T, { hasActiveShift: false }).access === 'shift_required');
  })());

  // Unchecking removes ONLY the company restriction; the plan still gates.
  let e = draftFromContract(GATED, { [T]: { requiresActiveShift: true } });
  e = setCompanyAppRequiresShift(e, T, false);
  const ePayload = companyAppConfigurationPayload(e);
  check('unchecking removes only the COMPANY restriction',
    !('requiresActiveShift' in (ePayload[T] ?? {})));
  check('  plan enforcement remains effective after unchecking',
    decideAppAccessWithConfiguration(GATED, ePayload, T, { hasActiveShift: false }).access === 'shift_required');

  // plan false + company true → checked box, NO inherited indicator.
  let f = beginConfiguringCompany(draftFromContract(INCLUDED, undefined));
  f = setCompanyAppRequiresShift(f, T, true);
  check('plan false + company true: box CHECKED, no plan indicator',
    rowOf(f).companyRequiresShift === true && rowOf(f).planMandatesShift === false);
  check('  and only the company gate enforces it',
    decideAppAccessWithConfiguration(INCLUDED, companyAppConfigurationPayload(f), T, { hasActiveShift: false }).access === 'shift_required'
    && decideAppAccessWithConfiguration(INCLUDED, undefined, T, { hasActiveShift: false }).access === 'allowed');

  // A company-DISABLED app can never also carry a shift requirement.
  let g = beginConfiguringCompany(draftFromContract(GATED, undefined));
  g = setCompanyAppRequiresShift(g, T, true);
  g = setCompanyAppEnabled(g, T, false);
  check('a company-disabled app cannot also require a shift',
    rowOf(g).companyRequiresShift === false
    && companyAppConfigurationPayload(g)[T].enabled === false
    && !('requiresActiveShift' in companyAppConfigurationPayload(g)[T]));
}

// ── absence semantics ─────────────────────────────────────────────────────
check('a company with no configuration opens as absent',
  draftFromContract(INCLUDED, undefined).state === 'absent');
check('merely opening writes NOTHING', (() => {
  const d = draftFromContract(INCLUDED, undefined);
  return companyAppConfigurationPayload(d) === null;
})());
check('cancelling (rebuild from stored state) writes nothing', (() => {
  const d = draftFromContract(INCLUDED, undefined);
  return companyAppConfigurationPayload(draftFromContract(INCLUDED, d.rows && undefined)) === null;
})());
check('toggling before configuring cannot materialize a map', (() => {
  const d = setCompanyAppEnabled(draftFromContract(INCLUDED, undefined), T, false);
  return d.state === 'absent' && companyAppConfigurationPayload(d) === null;
})());
check('an invalid stored configuration writes nothing until repaired', (() => {
  const d = draftFromContract(INCLUDED, null);
  return d.state === 'invalid' && companyAppConfigurationPayload(d) === null
    && canSaveCompanyAppSettings(d) === false;
})());
check('explicit configure + nothing restricted yields a deliberate {}', (() => {
  const d = beginConfiguringCompany(draftFromContract(INCLUDED, undefined));
  const payload = companyAppConfigurationPayload(d);
  return payload !== null && Object.keys(payload).length === 0;
})());
check('a stored {} opens as configured, not absent',
  draftFromContract(INCLUDED, {}).state === 'configured');

// ── narrowing writes ──────────────────────────────────────────────────────
check('a company can add a shift gate to an included app', (() => {
  let d = beginConfiguringCompany(draftFromContract(INCLUDED, undefined));
  d = setCompanyAppRequiresShift(d, T, true);
  const payload = companyAppConfigurationPayload(d);
  return payload[T].requiresActiveShift === true
    && decideAppAccessWithConfiguration(INCLUDED, payload, T, { hasActiveShift: false }).access === 'shift_required'
    && decideAppAccessWithConfiguration(INCLUDED, payload, T, { hasActiveShift: true }).access === 'allowed';
})());
check('a company can disable an included app', (() => {
  let d = beginConfiguringCompany(draftFromContract(INCLUDED, undefined));
  d = setCompanyAppEnabled(d, M, false);
  const payload = companyAppConfigurationPayload(d);
  return payload[M].enabled === false
    && decideAppAccessWithConfiguration(INCLUDED, payload, M, { hasActiveShift: true }).access === 'denied';
})());
check('disabling clears a company shift gate — the contradiction is unbuildable', (() => {
  let d = beginConfiguringCompany(draftFromContract(INCLUDED, undefined));
  d = setCompanyAppRequiresShift(d, T, true);
  d = setCompanyAppEnabled(d, T, false);
  const payload = companyAppConfigurationPayload(d);
  return payload[T].enabled === false && !('requiresActiveShift' in payload[T])
    && validateCompanyAppConfigurations(payload).ok === true;
})());
check('an enabled app with no gate states nothing and is omitted', (() => {
  const d = beginConfiguringCompany(draftFromContract(INCLUDED, undefined));
  return Object.keys(companyAppConfigurationPayload(d)).length === 0;
})());
check('every payload this editor can build passes canonical validation', (() => {
  let d = beginConfiguringCompany(draftFromContract(
    plan(Object.fromEntries(DESTINATION_APPS.map((a) => [a, { included: true }]))), undefined));
  for (const a of DESTINATION_APPS) d = setCompanyAppRequiresShift(d, a, true);
  const all = validateCompanyAppConfigurations(companyAppConfigurationPayload(d));
  for (const a of DESTINATION_APPS) d = setCompanyAppEnabled(d, a, false);
  const none = validateCompanyAppConfigurations(companyAppConfigurationPayload(d));
  return all.ok === true && none.ok === true;
})());
check('Suite is never in a payload', (() => {
  let d = beginConfiguringCompany(draftFromContract(INCLUDED, undefined));
  d = setCompanyAppRequiresShift(d, T, true);
  return !(S in companyAppConfigurationPayload(d));
})());
check('aliases and unknown keys are structurally impossible to submit', (() => {
  let d = beginConfiguringCompany(draftFromContract(
    plan(Object.fromEntries(DESTINATION_APPS.map((a) => [a, { included: true }]))), undefined));
  for (const a of DESTINATION_APPS) d = setCompanyAppEnabled(d, a, false);
  return Object.keys(companyAppConfigurationPayload(d))
    .every((k) => DESTINATION_APPS.includes(k));
})());
check('a valid draft validates locally', validateCompanyDraft(
  beginConfiguringCompany(draftFromContract(INCLUDED, undefined))).ok === true);

// ── Liquid Gold intended draft behaviour (no write performed) ─────────────
{
  // Shared plan still mandates the Tickets shift; company has no config.
  const lg = plan({
    [T]: { included: true, requiresActiveShift: true },
    [M]: { included: true }, [WELLBUILT_APP_EQUIPMENT]: { included: true },
    [WELLBUILT_APP_DASHBOARD]: { included: true },
  });
  const d = draftFromContract(lg, undefined);
  const tickets = d.rows.find((r) => r.app === T);
  check('Liquid Gold today: Tickets included with an INHERITED plan gate',
    tickets.plan.kind === 'included' && tickets.planMandatesShift === true);
  check('Liquid Gold today: no company configuration exists', d.state === 'absent');
  check('Liquid Gold today: viewing writes nothing',
    companyAppConfigurationPayload(d) === null);
  // After the future transition: gate moves to the company, plan drops it.
  const after = plan({ ...lg.apps, [T]: { included: true } });
  let moved = beginConfiguringCompany(draftFromContract(after, undefined));
  moved = setCompanyAppRequiresShift(moved, T, true);
  const payload = companyAppConfigurationPayload(moved);
  check('after transition: the gate is company-specific and still enforced',
    payload[T].requiresActiveShift === true
    && decideAppAccessWithConfiguration(after, payload, T, { hasActiveShift: false }).access === 'shift_required');
  check('after transition: another company on the same plan is not gated',
    decideAppAccessWithConfiguration(after, undefined, T, { hasActiveShift: false }).access === 'allowed');
}

// ── source pins ───────────────────────────────────────────────────────────
{
  const lib = readFileSync(join(root, 'src/lib/companyAppSettings.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the model calls the canonical company validator',
    /validateCompanyAppConfigurations\(/.test(lib));
  check('the model reads plan state through the canonical resolver',
    /resolveAppEntitlement\(/.test(lib));
  check('the model restates no app key or alias',
    !/'(wellbuilt-[a-z]+|wbt|wbew|wbjsa|wbm|water-ticket)'/.test(lib));
  check('the model performs no I/O', !/firebase|firestore|fetch\(|httpsCallable/i.test(lib));

  const panel = readFileSync(join(root, 'src/components/admin/CompanyContractPanel.tsx'), 'utf8');
  // Match an actual IMPORT STATEMENT, not the mention of one: this file's
  // own header says "NO firebase/firestore import exists in this file", and
  // a naive substring search reads that prose as the thing it denies.
  const panelCode = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the panel routes the write through the typed service',
    /service\.setCompanyAppConfiguration\(/.test(panelCode)
    && !/^import[^\n]*['"]firebase\/firestore['"]/m.test(panelCode));
  check('the panel never sends configurationVersion',
    !/configurationVersion:/.test(panel));
  check('the panel refetches after a write (run() reloads)',
    /void run\('Company app settings saved\.'/.test(panel) && /await reload\(\)/.test(panel));
  check('the panel gates materialization behind an explicit action',
    /Configure company app settings/.test(panel) && /beginConfiguringCompany/.test(panel));
  check('the panel offers no "restore absence" control',
    !/restore absence|clear app settings|reset to unconfigured/i.test(panel));
  check('the panel shows Suite as core and non-configurable',
    /Always included — core/.test(panel));
  check('the panel reports an inherited plan gate ALONGSIDE the company control',
    /also required by plan \(inherited\)/.test(panel));
  check('the company checkbox is NOT hidden when the plan mandates a shift', (() => {
    // The control and the indicator must both be reachable: the indicator
    // may only be a conditional SIBLING, never the checkbox's alternative.
    const hasCheckbox = /checked=\{row\.companyRequiresShift\}/.test(panelCode);
    const indicatorIsSibling = /\{row\.planMandatesShift && \(/.test(panelCode);
    const oldTernary = /row\.planMandatesShift \?/.test(panelCode);
    return hasCheckbox && indicatorIsSibling && !oldTernary;
  })());
  check('the company checkbox binds ONLY to the company flag',
    /checked=\{row\.companyRequiresShift\}/.test(panelCode)
    && !/checked=\{row\.companyRequiresShift \|\| row\.planMandatesShift\}/.test(panelCode));

  const plans = readFileSync(join(root, 'src/components/admin/PlansTab.tsx'), 'utf8');
  check('the PLAN editor wording is unmistakably global',
    /Plan mandates active shift for every company/.test(plans)
    && !/>\s*requires active shift\s*</.test(plans));
  check('the COMPANY wording is unmistakably per-company',
    /require active shift for this company/.test(panel));
}

console.log(`\ncompany app settings: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
