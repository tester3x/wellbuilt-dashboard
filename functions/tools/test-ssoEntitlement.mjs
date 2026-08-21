/**
 * vc51.9L — commercial app entitlement at authorization-code issuance.
 *
 * Drives the REAL handler against an in-memory SsoDeps. The property under
 * test is narrow: a code is minted only when the SELECTED company's plan
 * includes the requested destination app, and — when the plan says so —
 * only when the authoritative shift record proves an open period. Every
 * denial must leave the store byte-identical to never having been asked.
 *
 * Run: node tools/test-ssoEntitlement.mjs   (after npm run build)
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { handleSsoIssueCode } from '../lib/sso/ssoIssueHandler.js';
import { decideAppEntitlementAuthorization } from '../lib/sso/appEntitlementAuthorization.js';
import {
  SSO_AUDIENCE_WBT, SSO_AUDIENCE_EQUIPMENT, SSO_PROTOCOL_VERSION,
  SSO_CHALLENGE_METHOD,
  WELLBUILT_APP_TICKETS, WELLBUILT_APP_MOBILE, WELLBUILT_APP_SUITE,
  WELLBUILT_APP_DASHBOARD, WELLBUILT_APP_EQUIPMENT,
  reconcileAppConfiguration, resolveWellbuiltAppKey,
} from '@tester3x/wellbuilt-contracts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const DRIVER = 'driver-1';
const COMPANY = 'co-1';
const NOW = 1_700_000_000_000;
const CHALLENGE = createHash('sha256').update('v'.repeat(64), 'utf8').digest('base64url');
const AUTH = {
  uid: 'driver_driver1',
  claims: { kind: 'driver', driverId: DRIVER, companyId: COMPANY },
};
const REQUEST = {
  protocolVersion: SSO_PROTOCOL_VERSION,
  audience: SSO_AUDIENCE_WBT,
  codeChallenge: CHALLENGE,
  codeChallengeMethod: SSO_CHALLENGE_METHOD,
};

/** Minimal world: only what the entitlement decision consumes. */
function makeWorld({ contract = null, contractState = 'legacy', plan = null, authority = null } = {}) {
  const docs = new Map();
  const logs = [];
  let counter = 0;
  const deps = {
    nowMs: () => NOW,
    randomBytes: (n) => { counter += 1; const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = (i * 7 + counter * 31) & 0xff; return o; },
    sha256Hex: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
    base64Url: (b) => Buffer.from(b).toString('base64url'),
    expiresAtTimestamp: (ms) => ({ __timestamp: true, ms }),
    getDriver: async (id) => (id === DRIVER
      ? { driverId: DRIVER, companyId: COMPANY, active: true, displayName: 'Mike S' } : null),
    getCompanyContract: async () => ({ state: contractState, contract }),
    getPlan: async () => plan,
    getShiftAuthority: async () => authority,
    getShiftDay: async () => ({ readable: true, present: false }),
    runTransaction: async (fn) => {
      const writes = [];
      const r = await fn({
        get: async (p) => (docs.has(p) ? { exists: true, data: { ...docs.get(p) } } : { exists: false }),
        update: (p, f) => writes.push(['update', p, f]),
        create: (p, d) => writes.push(['create', p, d]),
      });
      for (const [k, p, d] of writes) {
        if (k === 'create') { if (docs.has(p)) throw new Error('ALREADY_EXISTS'); docs.set(p, d); }
        else { if (!docs.has(p)) throw new Error('NOT_FOUND'); docs.set(p, { ...docs.get(p), ...d }); }
      }
      return r;
    },
    mintCustomToken: async () => 'token',
    log: (event, fields) => logs.push({ event, fields }),
  };
  return { deps, docs, logs };
}

const CONTRACT = { planId: 'plan-1', contractEnforced: true };
const planWith = (apps) => {
  const p = { contractVersion: 1, planId: 'plan-1', displayName: 'P', capabilities: [], status: 'active' };
  if (apps !== undefined) p.apps = apps;
  return p;
};
const OPEN_AUTHORITY = {
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: '2026-08-11_223000', originLocalDate: '2026-08-11', version: 3,
};

async function issue(world, request = REQUEST, auth = AUTH) {
  try {
    const res = await handleSsoIssueCode(world.deps, auth, request);
    return { ok: true, res };
  } catch (e) {
    return { ok: false, code: e.code, publicCode: e.publicCode, internal: e.internalReason };
  }
}

/** Every denial must mint nothing and log no success. */
function mintedNothing(world) {
  return world.docs.size === 0
    && !world.logs.some((l) => l.event === 'sso.code.issued');
}

// ── plan state ────────────────────────────────────────────────────────────
{
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: planWith(undefined) });
  const r = await issue(w);
  check('plan with apps ABSENT is allowed (LEGACY_UNCONFIGURED)', r.ok && !!r.res.code);
}
// EVERY company has a plan. A missing contract is missing commercial
// authority, not a legacy entitlement configuration — it fails closed.
{
  const w = makeWorld({ contractState: 'legacy', contract: null, plan: null });
  const r = await issue(w);
  check('company with NO contract is DENIED',
    !r.ok && r.internal === 'contract_missing' && r.publicCode === 'not_authorized');
  check('  no contract mints zero code documents', w.docs.size === 0);
  check('  no contract emits no issuance success event',
    !w.logs.some((l) => l.event === 'sso.code.issued'));
  check('  no contract returns no authorization material', r.res === undefined);
  const refusal = w.logs.find((l) => l.event === 'sso.code.refused');
  check('  no contract is logged without exposing contract or plan state',
    !!refusal && !/planId|plan-1|wellbuiltContract|co-1|driver-1/i.test(JSON.stringify(refusal)));
}
{
  // Concurrency/replay cannot walk past a missing contract.
  const w = makeWorld({ contractState: 'legacy', contract: null, plan: null });
  const many = await Promise.all([issue(w), issue(w), issue(w), issue(w)]);
  check('concurrent attempts with no contract all deny and mint zero codes',
    many.every((x) => !x.ok && x.internal === 'contract_missing') && w.docs.size === 0);
}
{
  const w = makeWorld({
    contractState: 'active', contract: { contractEnforced: true }, plan: planWith(undefined),
  });
  const r = await issue(w);
  check('a contract with NO plan reference is denied',
    !r.ok && r.internal === 'plan_reference_invalid' && w.docs.size === 0);
}
{
  // An inert contract is a real commercial relationship whose operational
  // rules are not in force; the plan it names still governs entitlement.
  const w = makeWorld({ contractState: 'inert', contract: CONTRACT, plan: planWith(undefined) });
  const r = await issue(w);
  check('an INERT contract still consults its plan (relationship exists)', r.ok && !!r.res.code);
}
{
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: planWith({}) });
  const r = await issue(w);
  check('explicit {} denies the destination app', !r.ok && r.publicCode === 'not_authorized');
  check('  {} minted nothing', mintedNothing(w));
  check('  {} refused as a commercial exclusion', r.internal === 'app_not_entitled');
}
{
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT,
    plan: planWith({ [WELLBUILT_APP_TICKETS]: { included: true } }),
  });
  const r = await issue(w);
  check('explicitly included / no shift required is allowed', r.ok && !!r.res.code);
}
{
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT,
    plan: planWith({ [WELLBUILT_APP_TICKETS]: { included: false } }),
  });
  const r = await issue(w);
  check('explicitly excluded app is denied', !r.ok && mintedNothing(w));
}
{
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT,
    plan: planWith({ [WELLBUILT_APP_MOBILE]: { included: true } }),
  });
  const r = await issue(w);
  check('a DIFFERENT app included does not grant the requested one',
    !r.ok && r.internal === 'app_not_entitled' && mintedNothing(w));
}
for (const [label, apps] of [
  ['null', null], ['an array', []], ['a string', 'all'], ['a number', 7],
  ['an alias key', { wbt: { included: true } }],
  ['an unknown key', { 'wellbuilt-payroll': { included: true } }],
  ['a malformed entry', { [WELLBUILT_APP_TICKETS]: { included: 'yes' } }],
  ['a non-object entry', { [WELLBUILT_APP_TICKETS]: 3 }],
]) {
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: planWith(apps) });
  const r = await issue(w);
  check(`invalid entitlement data (${label}) denies`, !r.ok && mintedNothing(w));
}
{
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: null });
  const r = await issue(w);
  check('contract naming an ABSENT plan denies (broken pointer)',
    !r.ok && r.internal === 'plan_missing' && mintedNothing(w));
}
{
  const w = makeWorld({ contractState: 'invalid', contract: null, plan: null });
  const r = await issue(w);
  check('an INVALID stored contract denies', !r.ok && r.internal === 'contract_invalid');
}
{
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: 'not-an-object' });
  const r = await issue(w);
  check('a non-object plan denies', !r.ok && r.internal === 'plan_not_object' && mintedNothing(w));
}

// ── Suite / core ──────────────────────────────────────────────────────────
// Suite is not an issuable SSO audience today, so the core rule is proven
// at the decision seam the handler calls.
{
  const hostile = [
    ['{}', planWith({})],
    ['invalid apps', planWith(null)],
    ['excluding Suite', planWith({ [WELLBUILT_APP_SUITE]: { included: false } })],
    ['no plan at all', null],
  ];
  for (const [label, plan] of hostile) {
    const d = decideAppEntitlementAuthorization({
      app: WELLBUILT_APP_SUITE, contractState: 'active', contract: CONTRACT, plan, shift: null,
    });
    check(`Suite stays reachable under ${label}`, d.ok === true && d.detail === 'core_app_always_included');
  }
  // Core is decided BEFORE any contract or plan data is consulted, so even
  // the now-denying no-contract state leaves the hub reachable — which is
  // exactly where a driver would be told their company has no plan.
  for (const [label, state] of [['no contract', 'legacy'], ['invalid contract', 'invalid']]) {
    const d = decideAppEntitlementAuthorization({
      app: WELLBUILT_APP_SUITE, contractState: state, contract: null, plan: null, shift: null,
    });
    check(`Suite stays reachable with ${label}`, d.ok === true);
    for (const app of [WELLBUILT_APP_TICKETS, WELLBUILT_APP_EQUIPMENT]) {
      const dd = decideAppEntitlementAuthorization({
        app, contractState: state, contract: null, plan: null, shift: null,
      });
      check(`  ${label}: ${app} is still denied`, dd.ok === false);
    }
  }
  for (const [label, plan] of hostile.filter(([l]) => l !== 'no plan at all')) {
    for (const app of [WELLBUILT_APP_TICKETS, WELLBUILT_APP_EQUIPMENT, WELLBUILT_APP_MOBILE, WELLBUILT_APP_DASHBOARD]) {
      const d = decideAppEntitlementAuthorization({
        app, contractState: 'active', contract: CONTRACT, plan, shift: null,
      });
      check(`  ${label}: ${app} is NOT granted just because Suite is core`, d.ok === false);
    }
  }
}

// ── configuration ─────────────────────────────────────────────────────────
{
  const excluded = planWith({ [WELLBUILT_APP_TICKETS]: { included: false } });
  const included = planWith({ [WELLBUILT_APP_TICKETS]: { included: true } });
  check('configuration may NARROW an included entitlement',
    reconcileAppConfiguration(included, WELLBUILT_APP_TICKETS, false).effective === false);
  const widen = reconcileAppConfiguration(excluded, WELLBUILT_APP_TICKETS, true);
  check('configuration can NEVER enable an explicitly excluded app',
    widen.effective === false
    && widen.conflict === 'configuration_conflicts_with_app_entitlement');
  check('malformed entitlement data yields no effective enablement',
    reconcileAppConfiguration(planWith(null), WELLBUILT_APP_TICKETS, true).effective === false);
  // A cache lifetime is not a commercial entitlement — it cannot even be
  // stored, so it can never be mistaken for one.
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT,
    plan: planWith({ [WELLBUILT_APP_TICKETS]: { included: true, cacheTtlMs: 3600000 } }),
  });
  const r = await issue(w);
  check('non-commercial data (cacheTtlMs) is not read as entitlement — it denies',
    !r.ok && mintedNothing(w));
}

// ── shift gate ────────────────────────────────────────────────────────────
const SHIFT_PLAN = planWith({ [WELLBUILT_APP_TICKETS]: { included: true, requiresActiveShift: true } });
{
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT,
    plan: planWith({ [WELLBUILT_APP_TICKETS]: { included: true } }), authority: null,
  });
  const r = await issue(w);
  check('included / NO shift requirement is allowed while off shift', r.ok && !!r.res.code);
}
{
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: SHIFT_PLAN, authority: OPEN_AUTHORITY });
  const r = await issue(w);
  check('requires-shift is allowed with an authoritative OPEN shift', r.ok && !!r.res.code);
}
{
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: SHIFT_PLAN, authority: null });
  const r = await issue(w);
  check('requires-shift is DENIED with no authority record',
    !r.ok && r.internal === 'active_shift_required' && mintedNothing(w));
}
for (const [label, authority] of [
  ['a closed shift (null pointer)', { ...OPEN_AUTHORITY, openPeriodId: null, originLocalDate: null }],
  ['an uninitialized record', { ...OPEN_AUTHORITY, initialized: false }],
  ['a half-written record', { ...OPEN_AUTHORITY, originLocalDate: null }],
  ['a superseded/inconsistent record', { ...OPEN_AUTHORITY, originLocalDate: '2026-08-09' }],
  ['a record for ANOTHER company', { ...OPEN_AUTHORITY, companyId: 'co-2' }],
  ['a record for ANOTHER driver', { ...OPEN_AUTHORITY, driverId: 'driver-9' }],
]) {
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: SHIFT_PLAN, authority });
  const r = await issue(w);
  check(`requires-shift denied by ${label}`,
    !r.ok && r.internal === 'active_shift_required' && mintedNothing(w));
}
{
  // Cross-midnight: the authority is date-free, so an evening shift is
  // still open the next calendar day without any timezone being guessed.
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT, plan: SHIFT_PLAN,
    authority: { ...OPEN_AUTHORITY, openPeriodId: '2026-08-10_223000', originLocalDate: '2026-08-10' },
  });
  const r = await issue(w);
  check('a cross-midnight open shift still satisfies the gate', r.ok && !!r.res.code);
}
{
  // A client naming a shift on the tickets audience is refused by the
  // protocol validator — it can never be a route to the gate.
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: SHIFT_PLAN, authority: null });
  const r = await issue(w, { ...REQUEST, shiftBinding: { shiftId: '2026-08-11_223000', phase: 'pre_trip' } });
  check('a CLIENT-CLAIMED shift cannot satisfy the gate', !r.ok && mintedNothing(w));
}

// ── mutation / security ───────────────────────────────────────────────────
{
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: planWith({}) });
  await issue(w);
  check('a denial writes NO code document', w.docs.size === 0);
  check('a denial emits no success event', !w.logs.some((l) => l.event === 'sso.code.issued'));
  check('a denial IS recorded as a refusal for the operator',
    w.logs.some((l) => l.event === 'sso.code.refused'));
  const refusal = w.logs.find((l) => l.event === 'sso.code.refused');
  const serialized = JSON.stringify(refusal);
  check('the refusal log carries no identifiers, plan data, or authorization material',
    !/driver-1|co-1|uid-1|plan-1|codeChallenge|code"|verifier/i.test(serialized),
    serialized);
  check('the refusal log carries only the audience, reason and detail',
    JSON.stringify(Object.keys(refusal.fields).sort()) === '["audience","detail","reason"]',
    JSON.stringify(Object.keys(refusal.fields)));
}
{
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: planWith({}) });
  let thrown = null;
  try { await handleSsoIssueCode(w.deps, AUTH, REQUEST); } catch (e) { thrown = e; }
  check('the denial throws rather than returning a partial response', thrown !== null);
  check('nothing code-shaped is reachable on the thrown error',
    !('code' in thrown && /^[A-Za-z0-9_-]{43}$/.test(String(thrown.code)))
    && !('res' in thrown) && thrown.message === 'not_authorized');
  check('the message the client sees is exactly the coarse public code',
    thrown.publicCode === 'not_authorized' && thrown.message === thrown.publicCode);
  check('the precise reason stays on the operator-facing field only',
    thrown.internalReason === 'app_not_entitled'
    && !String(thrown.message).includes('app_not_entitled'));
}
{
  // The internal reason DOES distinguish them, for later Suite messaging.
  const excluded = await issue(makeWorld({
    contractState: 'active', contract: CONTRACT, plan: planWith({ [WELLBUILT_APP_TICKETS]: { included: false } }),
  }));
  const offShift = await issue(makeWorld({
    contractState: 'active', contract: CONTRACT, plan: SHIFT_PLAN, authority: null,
  }));
  check('commercial exclusion and shift-required are internally distinct',
    excluded.internal === 'app_not_entitled' && offShift.internal === 'active_shift_required');
}
{
  // Replay/concurrency: two concurrent allowed issuances still mint two
  // distinct codes, and a denied audience cannot be bypassed by racing.
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT,
    plan: planWith({ [WELLBUILT_APP_TICKETS]: { included: true } }),
  });
  const [a, b] = await Promise.all([issue(w), issue(w)]);
  check('concurrent allowed issuances both succeed with distinct codes',
    a.ok && b.ok && a.res.code !== b.res.code && w.docs.size === 2);

  const d = makeWorld({ contractState: 'active', contract: CONTRACT, plan: planWith({}) });
  const many = await Promise.all([issue(d), issue(d), issue(d), issue(d)]);
  check('concurrent denied issuances cannot race past the decision',
    many.every((x) => !x.ok) && d.docs.size === 0);
}
{
  // Spoofing: identity fields are a hard reject, and a client-named plan
  // or entitlement is simply never read.
  const w = makeWorld({ contractState: 'active', contract: CONTRACT, plan: planWith({}) });
  for (const spoof of [
    { companyId: 'co-other' }, { driverId: 'driver-9' }, { uid: 'uid-9' },
  ]) {
    const r = await issue(w, { ...REQUEST, ...spoof });
    check(`request-supplied ${Object.keys(spoof)[0]} is refused outright`,
      !r.ok && r.publicCode === 'malformed_request');
  }
  const r2 = await issue(w, { ...REQUEST, apps: { [WELLBUILT_APP_TICKETS]: { included: true } } });
  check('a client-supplied entitlement map cannot widen access', !r2.ok && w.docs.size === 0);
}
{
  // The decision is bound to the SELECTED company: the contract and plan
  // are fetched for driver.companyId from the authoritative record, never
  // from claims the caller could have influenced.
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT,
    plan: planWith({ [WELLBUILT_APP_TICKETS]: { included: true } }),
  });
  const r = await issue(w, REQUEST, { ...AUTH, claims: { ...AUTH.claims, companyId: 'co-2' } });
  check('claims naming another company cannot select another plan',
    !r.ok && r.publicCode === 'not_authorized' && w.docs.size === 0);
}

// ── company app configuration composed into issuance ─────────────────────
// PLAN decides what was bought; COMPANY CONFIGURATION decides how an
// included app operates for that company (disable / require a shift). The
// configuration can only NARROW: it can never enable a plan-excluded app
// and never relax a plan-level gate.
const cfgContract = (appConfiguration) => ({ planId: 'plan-1', contractEnforced: true, appConfiguration });
const INCLUDED_PLAN = planWith({ [WELLBUILT_APP_TICKETS]: { included: true } });
{
  // THE Liquid Gold shape: plan includes Tickets with NO plan-level shift
  // flag; the company's own configuration requires an active shift.
  const cfg = { [WELLBUILT_APP_TICKETS]: { requiresActiveShift: true } };
  const off = await issue(makeWorld({
    contractState: 'active', contract: cfgContract(cfg), plan: INCLUDED_PLAN, authority: null,
  }));
  check('company shift requirement DENIES off-shift even when the plan flag is off',
    !off.ok && off.internal === 'active_shift_required');
  const offW = makeWorld({
    contractState: 'active', contract: cfgContract(cfg), plan: INCLUDED_PLAN, authority: null,
  });
  await issue(offW);
  check('  the company-gate denial mints no authorization-code artifact', mintedNothing(offW));
  const on = await issue(makeWorld({
    contractState: 'active', contract: cfgContract(cfg), plan: INCLUDED_PLAN, authority: OPEN_AUTHORITY,
  }));
  check('company shift requirement ALLOWS with an authoritative open shift', on.ok && !!on.res.code);
}
{
  // Company-disabled app: included by the plan, off for this company.
  const cfg = { [WELLBUILT_APP_TICKETS]: { enabled: false } };
  const w = makeWorld({ contractState: 'active', contract: cfgContract(cfg), plan: INCLUDED_PLAN });
  const r = await issue(w);
  check('an included app DISABLED by company configuration is denied',
    !r.ok && r.internal === 'app_not_entitled' && mintedNothing(w));
  const refusal = w.logs.find((l) => l.event === 'sso.code.refused');
  check('  the disabled-by-company detail is bounded and nonsecret',
    !!refusal && /disabled_by_company_configuration/.test(refusal.fields.detail)
    && !/driver-1|co-1|plan-1/i.test(JSON.stringify(refusal)));
}
{
  // Absence composes as absence; a deliberate {} states no restriction.
  const absent = await issue(makeWorld({
    contractState: 'active', contract: CONTRACT, plan: INCLUDED_PLAN, authority: null,
  }));
  check('configuration ABSENT preserves plan-only behavior', absent.ok && !!absent.res.code);
  const empty = await issue(makeWorld({
    contractState: 'active', contract: cfgContract({}), plan: INCLUDED_PLAN, authority: null,
  }));
  check('a deliberate {} configuration adds no restriction', empty.ok && !!empty.res.code);
  const legacyPlan = await issue(makeWorld({
    contractState: 'active', contract: cfgContract({}), plan: planWith(undefined), authority: null,
  }));
  check('LEGACY_UNCONFIGURED plans keep the accepted permissive behavior under {}',
    legacyPlan.ok && !!legacyPlan.res.code);
}
{
  // Malformed configuration fails closed at the decision seam (the
  // contract loader independently classifies such contracts invalid).
  for (const [label, cfg] of [
    ['an array', []], ['a string', 'all'],
    ['an alias key', { wbt: { enabled: false } }],
    ['an unknown key', { 'wellbuilt-payroll': { enabled: false } }],
    ['a malformed entry', { [WELLBUILT_APP_TICKETS]: { enabled: 'no' } }],
    ['an unknown field', { [WELLBUILT_APP_TICKETS]: { disabled: true } }],
  ]) {
    const d = decideAppEntitlementAuthorization({
      app: WELLBUILT_APP_TICKETS, contractState: 'active',
      contract: cfgContract(cfg), plan: INCLUDED_PLAN, shift: null,
    });
    check(`malformed company configuration (${label}) denies`,
      d.ok === false && d.refusal === 'app_not_entitled');
  }
}
{
  // Narrowing only: configuration can never widen.
  const excludedPlan = planWith({ [WELLBUILT_APP_TICKETS]: { included: false } });
  const enableAttempt = { [WELLBUILT_APP_TICKETS]: { enabled: true } };
  const r = await issue(makeWorld({
    contractState: 'active', contract: cfgContract(enableAttempt), plan: excludedPlan,
  }));
  check('configuration cannot enable a plan-EXCLUDED app',
    !r.ok && r.internal === 'app_not_entitled');

  // Legacy plan-level gate: still honored fail-closed, and a company
  // configuration cannot relax it (requiresActiveShift:false normalizes
  // to "adds nothing", and gates OR together).
  const relaxAttempt = { [WELLBUILT_APP_TICKETS]: { requiresActiveShift: false } };
  const rr = await issue(makeWorld({
    contractState: 'active', contract: cfgContract(relaxAttempt), plan: SHIFT_PLAN, authority: null,
  }));
  check('configuration cannot relax a legacy plan-level shift gate',
    !rr.ok && rr.internal === 'active_shift_required');
  const rrOpen = await issue(makeWorld({
    contractState: 'active', contract: cfgContract(relaxAttempt), plan: SHIFT_PLAN, authority: OPEN_AUTHORITY,
  }));
  check('  the legacy plan gate still allows with an authoritative open shift',
    rrOpen.ok && !!rrOpen.res.code);
}
{
  // Both gates at once behave as one gate: either source requires a shift.
  const cfg = { [WELLBUILT_APP_TICKETS]: { requiresActiveShift: true } };
  const r = await issue(makeWorld({
    contractState: 'active', contract: cfgContract(cfg), plan: SHIFT_PLAN, authority: null,
  }));
  check('plan gate OR company gate: both present still denies off-shift',
    !r.ok && r.internal === 'active_shift_required');
}
{
  // Suite stays core under hostile company configuration.
  for (const [label, cfg] of [
    ['disabling Suite', { [WELLBUILT_APP_SUITE]: { enabled: false } }],
    ['shift-gating Suite', { [WELLBUILT_APP_SUITE]: { requiresActiveShift: true } }],
    ['malformed config', 'nonsense'],
  ]) {
    const d = decideAppEntitlementAuthorization({
      app: WELLBUILT_APP_SUITE, contractState: 'active',
      contract: cfgContract(cfg), plan: planWith({}), shift: null,
    });
    check(`Suite stays core under company configuration ${label}`,
      d.ok === true && d.detail === 'core_app_always_included');
  }
}

// ── canonical mapping, no second naming table ─────────────────────────────
{
  check('the audience maps to a canonical app key through the contract',
    resolveWellbuiltAppKey(SSO_AUDIENCE_WBT) === WELLBUILT_APP_TICKETS
    && resolveWellbuiltAppKey(SSO_AUDIENCE_EQUIPMENT) === WELLBUILT_APP_EQUIPMENT);
  const d = decideAppEntitlementAuthorization({
    app: null, contractState: 'active', contract: CONTRACT, plan: planWith({}), shift: null,
  });
  check('an audience with no canonical app key fails closed',
    d.ok === false && d.refusal === 'app_not_recognized');
}

console.log(`\nsso entitlement: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
