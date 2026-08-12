/**
 * vc51.9L — plan app-entitlement display and editing.
 *
 * The load-bearing property is omission: a legacy plan must survive being
 * opened, edited and cancelled without its absent `apps` field turning
 * into `{}`. `{}` is an authoritative statement that the company gets no
 * destination apps, and nobody should make it by accident.
 *
 * Run: node tools/test-planEntitlement.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WELLBUILT_APP_PRODUCT_NAMES,
  DESTINATION_APPS,
  describePlanEntitlement,
  draftFromStoredApps,
  beginConfiguring,
  setAppIncluded,
  setAppRequiresShift,
  entitlementPayload,
  validateDraft,
  canSaveEntitlements,
} from '../src/lib/planEntitlement.ts';
import {
  WELLBUILT_APP_TICKETS, WELLBUILT_APP_MOBILE, WELLBUILT_APP_SUITE,
  WELLBUILT_APP_EQUIPMENT, WELLBUILT_APP_JSA, WELLBUILT_APP_DASHBOARD,
  validatePlanAppEntitlements, isCoreApp,
} from '@tester3x/wellbuilt-contracts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

// ── display ───────────────────────────────────────────────────────────────
check('absent apps shows the legacy badge', (() => {
  const d = describePlanEntitlement(undefined);
  return d.kind === 'legacy' && /legacy/i.test(d.label) && d.tone === 'neutral';
})());
check('explicit {} shows "no destination apps"', (() => {
  const d = describePlanEntitlement({});
  return d.kind === 'none' && /no destination apps/i.test(d.label);
})());
check('a single included app shows a configured count', (() => {
  const d = describePlanEntitlement({ [WELLBUILT_APP_TICKETS]: { included: true } });
  return d.kind === 'configured' && d.included === 1 && d.total === DESTINATION_APPS.length;
})());
check('multiple entries count only the INCLUDED ones', (() => {
  const d = describePlanEntitlement({
    [WELLBUILT_APP_TICKETS]: { included: true, requiresActiveShift: true },
    [WELLBUILT_APP_MOBILE]: { included: true },
    [WELLBUILT_APP_DASHBOARD]: { included: false },
  });
  return d.kind === 'configured' && d.included === 2;
})());
for (const [label, apps] of [
  ['null', null], ['an array', []], ['a string', 'all'], ['a number', 3], ['a boolean', true],
  ['an alias key', { wbt: { included: true } }],
  ['the water-ticket alias', { 'water-ticket': { included: true } }],
  ['an unknown key', { 'wellbuilt-payroll': { included: true } }],
  ['a malformed entry', { [WELLBUILT_APP_TICKETS]: { included: 'yes' } }],
  ['a non-object entry', { [WELLBUILT_APP_TICKETS]: 5 }],
  ['a shift-gated exclusion', { [WELLBUILT_APP_TICKETS]: { included: false, requiresActiveShift: true } }],
  ['an excluded Suite', { [WELLBUILT_APP_SUITE]: { included: false } }],
]) {
  const d = describePlanEntitlement(apps);
  check(`${label} shows the INVALID warning`,
    d.kind === 'invalid' && d.tone === 'danger' && /invalid/i.test(d.label));
  check(`  ${label} is never shown as legacy or empty`,
    d.kind !== 'legacy' && d.kind !== 'none');
}
check('Suite is core under every state and is never a destination row', (() => {
  const states = [undefined, {}, null, { [WELLBUILT_APP_TICKETS]: { included: true } }];
  return isCoreApp(WELLBUILT_APP_SUITE)
    && !DESTINATION_APPS.includes(WELLBUILT_APP_SUITE)
    && states.every(() => !draftFromStoredApps(undefined).rows.some((r) => r.app === WELLBUILT_APP_SUITE));
})());
check('every destination app has a canonical product name, no aliases', (() => {
  const names = DESTINATION_APPS.map((a) => WELLBUILT_APP_PRODUCT_NAMES[a]);
  return names.every((n) => typeof n === 'string' && n.startsWith('WellBuilt'))
    && !JSON.stringify(WELLBUILT_APP_PRODUCT_NAMES).match(/wbt|wbew|water-ticket|wbjsa|wbm|wbs/);
})());

// ── editing: omission is preserved ────────────────────────────────────────
check('a legacy plan opens as legacy', draftFromStoredApps(undefined).state === 'legacy');
check('opening a legacy plan materializes NOTHING', (() => {
  const d = draftFromStoredApps(undefined);
  return !('apps' in entitlementPayload(d));
})());
check('cancelling (never configuring) still omits apps', (() => {
  // Simulate open → change nothing → save.
  const d = draftFromStoredApps(undefined);
  const payload = entitlementPayload(d);
  return Object.keys(payload).length === 0;
})());
check('an unrelated edit on a legacy plan omits apps from the payload', (() => {
  const d = draftFromStoredApps(undefined);
  const request = { planId: 'p', displayName: 'Renamed', capabilities: [], ...entitlementPayload(d) };
  return !('apps' in request) && request.displayName === 'Renamed';
})());
check('toggling before configuring is refused (state gate holds)', (() => {
  const d = setAppIncluded(draftFromStoredApps(undefined), WELLBUILT_APP_TICKETS, true);
  return d.state === 'legacy' && !('apps' in entitlementPayload(d));
})());

// ── editing: deliberate configuration ─────────────────────────────────────
check('"Configure app access" materializes an empty, all-excluded map', (() => {
  const d = beginConfiguring(draftFromStoredApps(undefined));
  const payload = entitlementPayload(d);
  return d.state === 'configured' && 'apps' in payload
    && DESTINATION_APPS.every((a) => payload.apps[a].included === false);
})());
check('a deliberate empty configuration submits an authoritative statement', (() => {
  const d = beginConfiguring(draftFromStoredApps(undefined));
  const payload = entitlementPayload(d);
  // Every destination explicitly excluded — the canonical resolver reads
  // this exactly as `{}` does: no destination apps.
  return validatePlanAppEntitlements(payload.apps).ok === true
    && DESTINATION_APPS.every((a) => payload.apps[a].included === false);
})());
check('included / no shift submits { included: true } only', (() => {
  let d = beginConfiguring(draftFromStoredApps(undefined));
  d = setAppIncluded(d, WELLBUILT_APP_TICKETS, true);
  const e = entitlementPayload(d).apps[WELLBUILT_APP_TICKETS];
  return e.included === true && !('requiresActiveShift' in e);
})());
check('included / requires shift submits the shift flag', (() => {
  let d = beginConfiguring(draftFromStoredApps(undefined));
  d = setAppIncluded(d, WELLBUILT_APP_TICKETS, true);
  d = setAppRequiresShift(d, WELLBUILT_APP_TICKETS, true);
  const e = entitlementPayload(d).apps[WELLBUILT_APP_TICKETS];
  return e.included === true && e.requiresActiveShift === true;
})());
check('an EXCLUDED app can never carry a shift requirement', (() => {
  let d = beginConfiguring(draftFromStoredApps(undefined));
  // Try the hostile order: include, shift-gate, then exclude.
  d = setAppIncluded(d, WELLBUILT_APP_TICKETS, true);
  d = setAppRequiresShift(d, WELLBUILT_APP_TICKETS, true);
  d = setAppIncluded(d, WELLBUILT_APP_TICKETS, false);
  const row = d.rows.find((r) => r.app === WELLBUILT_APP_TICKETS);
  const e = entitlementPayload(d).apps[WELLBUILT_APP_TICKETS];
  return row.requiresActiveShift === false && e.included === false
    && !('requiresActiveShift' in e);
})());
check('shift-gating an excluded app is a no-op, not a stored contradiction', (() => {
  let d = beginConfiguring(draftFromStoredApps(undefined));
  d = setAppRequiresShift(d, WELLBUILT_APP_TICKETS, true);
  return d.rows.find((r) => r.app === WELLBUILT_APP_TICKETS).requiresActiveShift === false;
})());
check('an existing configured plan round-trips through the editor unchanged', (() => {
  const stored = {
    [WELLBUILT_APP_TICKETS]: { included: true, requiresActiveShift: true },
    [WELLBUILT_APP_MOBILE]: { included: true },
    [WELLBUILT_APP_EQUIPMENT]: { included: false },
    [WELLBUILT_APP_JSA]: { included: false },
    [WELLBUILT_APP_DASHBOARD]: { included: false },
  };
  const payload = entitlementPayload(draftFromStoredApps(stored));
  return JSON.stringify(payload.apps) === JSON.stringify(
    Object.fromEntries(DESTINATION_APPS.map((a) => [a, stored[a]])));
})());
check('every payload the editor can build passes canonical validation', (() => {
  let d = beginConfiguring(draftFromStoredApps(undefined));
  for (const app of DESTINATION_APPS) {
    d = setAppIncluded(d, app, true);
    d = setAppRequiresShift(d, app, true);
  }
  const all = validatePlanAppEntitlements(entitlementPayload(d).apps);
  for (const app of DESTINATION_APPS) d = setAppIncluded(d, app, false);
  const none = validatePlanAppEntitlements(entitlementPayload(d).apps);
  return all.ok === true && none.ok === true;
})());
check('Suite is never submitted in the map', (() => {
  let d = beginConfiguring(draftFromStoredApps(undefined));
  for (const app of DESTINATION_APPS) d = setAppIncluded(d, app, true);
  return !(WELLBUILT_APP_SUITE in entitlementPayload(d).apps);
})());
check('aliases and unknown keys are structurally impossible to submit', (() => {
  let d = beginConfiguring(draftFromStoredApps(undefined));
  for (const app of DESTINATION_APPS) d = setAppIncluded(d, app, true);
  const keys = Object.keys(entitlementPayload(d).apps);
  return keys.every((k) => DESTINATION_APPS.includes(k))
    && !keys.some((k) => ['wbt', 'wbew', 'water-ticket', 'wbjsa', 'wbm'].includes(k));
})());

// ── invalid stored data needs deliberate repair ───────────────────────────
check('invalid stored data opens as invalid, not legacy or empty', (() => {
  const d = draftFromStoredApps({ wbt: { included: true } });
  return d.state === 'invalid' && typeof d.invalidReason === 'string';
})());
check('invalid stored data cannot be saved', (() => {
  const d = draftFromStoredApps(null);
  return canSaveEntitlements(d) === false && validateDraft(d).ok === false;
})());
check('invalid stored data submits NOTHING until repaired', (() => {
  const d = draftFromStoredApps([]);
  return !('apps' in entitlementPayload(d));
})());
check('deliberate reconfiguration repairs an invalid plan', (() => {
  let d = beginConfiguring(draftFromStoredApps({ 'wellbuilt-payroll': { included: true } }));
  d = setAppIncluded(d, WELLBUILT_APP_TICKETS, true);
  const payload = entitlementPayload(d);
  return canSaveEntitlements(d) === true
    && validatePlanAppEntitlements(payload.apps).ok === true
    && !('wellbuilt-payroll' in payload.apps);
})());
check('a legacy draft always validates (nothing to reject)',
  validateDraft(draftFromStoredApps(undefined)).ok === true);

// ── create/update payload semantics ───────────────────────────────────────
check('create with an untouched section omits apps', (() => {
  const req = { planId: 'new', displayName: 'N', capabilities: [], ...entitlementPayload(draftFromStoredApps(undefined)) };
  return !('apps' in req);
})());
check('create with a configured section includes apps', (() => {
  const d = beginConfiguring(draftFromStoredApps(undefined));
  const req = { planId: 'new', displayName: 'N', capabilities: [], ...entitlementPayload(d) };
  return 'apps' in req;
})());
check('update with an untouched legacy section omits apps', (() => {
  const req = { planId: 'p', displayName: 'X', ...entitlementPayload(draftFromStoredApps(undefined)) };
  return !('apps' in req) && Object.keys(req).join(',') === 'planId,displayName';
})());
check('update on an already-configured plan resubmits its map', (() => {
  const stored = { [WELLBUILT_APP_TICKETS]: { included: true } };
  const req = { planId: 'p', displayName: 'X', ...entitlementPayload(draftFromStoredApps(stored)) };
  return 'apps' in req && req.apps[WELLBUILT_APP_TICKETS].included === true;
})());

// ── source pins: no second opinion, no direct writes ──────────────────────
{
  const src = readFileSync(join(root, 'src/lib/planEntitlement.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the editor calls the canonical validator',
    /validatePlanAppEntitlements\(/.test(src));
  check('the editor does not restate app keys, aliases or core rules', (() => {
    // Canonical keys may appear only as IMPORTED identifiers, never as
    // string literals, and no alias may appear at all.
    const literals = src.match(/'(wellbuilt-[a-z]+|wbt|wbew|wbjsa|wbm|wbs|water-ticket)'/g);
    return literals === null;
  })());
  check('the editor performs no I/O and touches no Firestore',
    !/firebase|firestore|fetch\(|httpsCallable/i.test(src));
  const tab = readFileSync(join(root, 'src/components/admin/PlansTab.tsx'), 'utf8');
  check('PlansTab still routes every mutation through the typed service',
    !/firebase\/firestore/.test(tab) && /service\.(createPlan|updatePlan)\(/.test(tab));
  check('PlansTab spreads the payload rather than assigning apps directly',
    /\.\.\.appsPayload/.test(tab) && !/apps:\s*entitlements/.test(tab));
  check('PlansTab disables save on invalid entitlement data',
    /disabled=\{busy \|\| !canSaveEntitlements\(entitlements\)\}/.test(tab));
  check('PlansTab gates materialization behind an explicit action',
    /Configure app access/.test(tab) && /beginConfiguring/.test(tab));
  check('PlansTab offers no misleading "clear back to legacy" action',
    !/clear app access|restore legacy|reset to legacy/i.test(tab));
}

console.log(`\nplan entitlement: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
