/**
 * vc51.9A6-B — protected admin callable matrix (mocked Admin SDK).
 *
 * Imports the COMPILED handlers (functions/lib), drives them through an
 * in-memory AdminDeps mock with real transaction semantics (buffered
 * writes, atomic commit, rollback on throw), and pins:
 *
 *   Part 11 — the 10-identity authorization matrix on EVERY handler;
 *   Part 12 — plan / company-contract / replacement / read behavior;
 *   source pins — every exported handler routes through requireAdmin,
 *   every handler is wrapped as a callable, index.ts exports them, and
 *   no plan-delete or company-hard-delete surface exists.
 *
 * Run (after functions build): node tools/test-adminCallables.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as H from '../functions/lib/admin/adminHandlers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Resolve contracts from FUNCTIONS' tree, not the repo root's: the
// handlers under test are built against the Functions contracts mirror,
// and the root install carries its own pin.
const require0 = createRequire(join(root, 'functions', 'package.json'));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const denied = async (name, promise, code, adminCode = null) => {
  try {
    await promise;
    check(name, false, 'unexpectedly succeeded');
  } catch (e) {
    check(name, e.code === code && (adminCode === null || e.adminCode === adminCode),
      `got code=${e.code} adminCode=${e.adminCode}`);
  }
};

// ── in-memory AdminDeps with real transaction semantics ───────────────────
const NOW = Date.parse('2026-08-06T15:00:00.000Z');
function makeDeps(seed = {}) {
  const store = new Map(Object.entries(structuredClone(seed)));
  let auditSeq = 0;
  return {
    store,
    async getDoc(path) {
      const d = store.get(path);
      return { exists: d !== undefined, data: d ? structuredClone(d) : undefined };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(path) {
          const d = store.get(path);
          return { exists: d !== undefined, data: d ? structuredClone(d) : undefined };
        },
        update(path, fields) { writes.push(['update', path, structuredClone(fields)]); },
        create(path, data) { writes.push(['create', path, structuredClone(data)]); },
      };
      const result = await fn(tx); // a throw here commits NOTHING
      for (const [kind, path, data] of writes) {
        const cur = store.get(path);
        if (kind === 'update') {
          if (cur === undefined) throw new Error(`tx.update on missing doc: ${path}`);
          store.set(path, { ...cur, ...data });
        } else {
          if (cur !== undefined) throw new Error(`tx.create on existing doc: ${path}`);
          store.set(path, data);
        }
      }
      return result;
    },
    async listDocsById(collection, { direction, limit, startAfterId }) {
      let ids = [...store.keys()]
        .filter((p) => p.startsWith(`${collection}/`))
        .map((p) => p.slice(collection.length + 1))
        .sort();
      if (direction === 'desc') ids.reverse();
      if (startAfterId !== undefined) {
        ids = ids.filter((id) => (direction === 'asc' ? id > startAfterId : id < startAfterId));
      }
      return ids.slice(0, limit).map((id) => ({ id, data: structuredClone(store.get(`${collection}/${id}`)) }));
    },
    newAuditId() {
      auditSeq++;
      return `${String(NOW + auditSeq).padStart(15, '0')}_${auditSeq.toString(16).padStart(8, '0')}`;
    },
    serverTimestamp() { return '<server-ts>'; },
    nowMs() { return NOW; },
    audits() {
      return [...store.entries()].filter(([p]) => p.startsWith('platform_admin_audit/')).map(([, v]) => v);
    },
  };
}

// ── identities ────────────────────────────────────────────────────────────
const ADMIN_UID = 'admin-mike';
const enabledRecord = { enabled: true, policyVersion: 1 };
const IDENT = {
  unauth: { auth: null, expect: ['unauthenticated', 'unauthenticated'] },
  ordinary: { auth: { uid: 'user-1', token: {} }, expect: ['permission-denied', 'missing_admin_claim'] },
  viewAdminProfile: { auth: { uid: 'user-2', token: { viewAdmin: true, role: 'admin' } }, expect: ['permission-denied', 'missing_admin_claim'] },
  claimNoRecord: { auth: { uid: 'claim-norec', token: { wellbuiltAdmin: true } }, expect: ['permission-denied', 'no_admin_record'] },
  recordNoClaim: { auth: { uid: 'rec-noclaim', token: {} }, expect: ['permission-denied', 'missing_admin_claim'] },
  malformedRecord: { auth: { uid: 'rec-bad', token: { wellbuiltAdmin: true } }, expect: ['permission-denied', 'admin_record_malformed'] },
  unsupportedPolicy: { auth: { uid: 'rec-pol', token: { wellbuiltAdmin: true } }, expect: ['permission-denied', 'unsupported_policy_version'] },
  disabledRecord: { auth: { uid: 'rec-off', token: { wellbuiltAdmin: true } }, expect: ['permission-denied', 'admin_record_disabled'] },
};
const ADMIN_AUTH = { uid: ADMIN_UID, token: { wellbuiltAdmin: true, email: 'mike@wellbuilt.app' } };
const identitySeed = {
  [`platform_admins/${ADMIN_UID}`]: enabledRecord,
  'platform_admins/rec-noclaim': enabledRecord,
  'platform_admins/rec-bad': { enabled: 'yes', policyVersion: 1 },
  'platform_admins/rec-pol': { enabled: true, policyVersion: 2 },
  'platform_admins/rec-off': { enabled: false, policyVersion: 1 },
};

// Handlers under test with a VALID payload each (so only authz differs).
const CONTRACT = {
  contractVersion: 1, configurationVersion: 1, planId: 'plan-field',
  entitlementOverrides: [], workPeriodConfiguration: { mode: 'explicit_shift' },
  contractEnforced: false,
};
const behaviorSeed = {
  ...identitySeed,
  'plans/plan-field': { contractVersion: 1, planId: 'plan-field', displayName: 'Field', capabilities: ['jsa', 'dvir', 'explicitShiftLifecycle'], status: 'active' },
  'plans/plan-old': { contractVersion: 1, planId: 'plan-old', displayName: 'Old', capabilities: ['jsa'], status: 'deprecated' },
  'companies/legacy-co': { name: 'Legacy Co', invoicePrefix: 'LG' },
  'companies/configured-co': { name: 'Configured Co', wellbuiltContract: structuredClone(CONTRACT) },
  'companies/broken-co': { name: 'Broken Co', wellbuiltContract: { contractVersion: 99 } },
};
const HANDLERS = [
  ['createPlanHandler', { planId: 'plan-new', displayName: 'New', capabilities: ['jsa'] }],
  ['updatePlanHandler', { planId: 'plan-field', displayName: 'Field 2' }],
  ['deprecatePlanHandler', { planId: 'plan-field' }],
  ['assignCompanyPlanHandler', { companyId: 'legacy-co', planId: 'plan-field' }],
  ['addEntitlementOverrideHandler', { companyId: 'configured-co', capability: 'billing', granted: true, reason: 'pilot' }],
  ['removeEntitlementOverrideHandler', { companyId: 'configured-co', capability: 'billing', reason: 'pilot over' }],
  ['setCompanyWorkPeriodConfigurationHandler', { companyId: 'configured-co', configuration: { mode: 'explicit_shift' } }],
  ['setCompanyContractEnforcementHandler', { companyId: 'configured-co', enforced: true }],
  ['updateCompanySafeHandler', { companyId: 'configured-co', fields: { name: 'Configured Co LLC' } }],
  ['archiveCompanyHandler', { companyId: 'legacy-co', confirmCompanyId: 'legacy-co', reason: 'closed' }],
  ['listPlansHandler', {}],
  ['getPlanHandler', { planId: 'plan-field' }],
  ['getCompanyContractConfigurationHandler', { companyId: 'configured-co' }],
  ['previewCompanyEffectiveCapabilitiesHandler', { companyId: 'configured-co' }],
  ['listAdminAuditHandler', {}],
];

// ── Part 11: authorization matrix — 9 denial identities × 15 handlers ─────
for (const [handlerName, payload] of HANDLERS) {
  for (const [identName, ident] of Object.entries(IDENT)) {
    const deps = makeDeps(behaviorSeed);
    await denied(`${handlerName} × ${identName} denied`,
      H[handlerName](deps, ident.auth, payload), ident.expect[0], ident.expect[1]);
  }
  // Body fake-admin: ordinary auth, body smuggles admin/actor fields —
  // authorization happens BEFORE payload parsing, so the body cannot help.
  {
    const deps = makeDeps(behaviorSeed);
    await denied(`${handlerName} × bodyFakeAdmin denied (body ignored)`,
      H[handlerName](deps, { uid: 'user-9', token: {} },
        { ...payload, wellbuiltAdmin: true, actorUid: ADMIN_UID }),
      'permission-denied', 'missing_admin_claim');
  }
}
// claim + enabled record → allowed (proven per-handler by every behavior
// case below using ADMIN_AUTH; assert one explicitly here)
{
  const deps = makeDeps(behaviorSeed);
  const r = await H.listPlansHandler(deps, ADMIN_AUTH, {});
  check('claim + enabled record allowed', Array.isArray(r.plans) && r.plans.length === 2);
}

// ── Part 12: behavior matrix ──────────────────────────────────────────────

// Plans.
{
  const deps = makeDeps(behaviorSeed);
  const r = await H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-god', displayName: 'God', capabilities: ['jsa', 'dvir', 'billing'] });
  check('plan create valid', r.planId === 'plan-god' && r.status === 'active');
  const doc = deps.store.get('plans/plan-god');
  check('plan doc written with server-set contractVersion',
    doc.contractVersion === 1 && doc.status === 'active' && doc.capabilities.length === 3);
  const audits = deps.audits();
  check('plan create audited with verified actor',
    audits.length === 1 && audits[0].operation === 'plan.create'
    && audits[0].actorUid === ADMIN_UID && audits[0].actorEmail === 'mike@wellbuilt.app'
    && audits[0].at === '<server-ts>');
  await denied('duplicate plan create rejected',
    H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-god', displayName: 'Again', capabilities: [] }),
    'already-exists', 'plan_already_exists');
  await denied('plan create extra field rejected',
    H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-x', displayName: 'X', capabilities: [], status: 'active' }),
    'invalid-argument', 'unknown_fields:status');
  await denied('plan create client-supplied contractVersion rejected',
    H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-x', displayName: 'X', capabilities: [], contractVersion: 2 }),
    'invalid-argument', 'unknown_fields:contractVersion');
  await denied('plan create unknown capability rejected',
    H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-x', displayName: 'X', capabilities: ['root'] }),
    'invalid-argument', 'unknown_capability:root');
  await denied('plan create bad id rejected',
    H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'Bad Id!', displayName: 'X', capabilities: [] }),
    'invalid-argument', 'invalid_plan_id');
}
{
  const deps = makeDeps(behaviorSeed);
  const r = await H.updatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-field', displayName: 'Field v2' });
  check('plan update works', r.changedFields.join(',') === 'displayName'
    && deps.store.get('plans/plan-field').displayName === 'Field v2');
  await denied('plan update nonexistent rejected',
    H.updatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-none', displayName: 'X' }), 'not-found', 'plan_not_found');
  const d2 = await H.deprecatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-field' });
  check('plan deprecate works', d2.status === 'deprecated');
  await denied('double deprecate rejected',
    H.deprecatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-field' }), 'failed-precondition', 'plan_already_deprecated');
  check('deprecation left assigned company contract untouched',
    deps.store.get('companies/configured-co').wellbuiltContract.planId === 'plan-field');
}
check('no destructive plan deletion handler exists',
  !Object.keys(H).some((k) => /delete.*plan|plan.*delete/i.test(k)));
check('no company hard-delete handler exists',
  !Object.keys(H).some((k) => /delete/i.test(k)));

// Company contract.
{
  const deps = makeDeps(behaviorSeed);
  const r = await H.assignCompanyPlanHandler(deps, ADMIN_AUTH, { companyId: 'legacy-co', planId: 'plan-field' });
  const co = deps.store.get('companies/legacy-co');
  check('assign to legacy company creates v1 inert contract',
    r.configurationVersion === 1 && co.wellbuiltContract.planId === 'plan-field'
    && co.wellbuiltContract.contractEnforced === false
    && co.wellbuiltContract.entitlementOverrides.length === 0);
  check('unrelated fields preserved on assignment',
    co.name === 'Legacy Co' && co.invoicePrefix === 'LG');

  const before = structuredClone(deps.store.get('companies/legacy-co'));
  const auditCountBefore = deps.audits().length;
  await denied('assign missing plan rejected',
    H.assignCompanyPlanHandler(deps, ADMIN_AUTH, { companyId: 'legacy-co', planId: 'plan-ghost' }),
    'not-found', 'plan_not_found');
  check('transaction rollback: no partial write, no audit on failure',
    JSON.stringify(deps.store.get('companies/legacy-co')) === JSON.stringify(before)
    && deps.audits().length === auditCountBefore);

  await denied('assign deprecated plan rejected',
    H.assignCompanyPlanHandler(deps, ADMIN_AUTH, { companyId: 'legacy-co', planId: 'plan-old' }),
    'failed-precondition', 'plan_deprecated');
  const mig = await H.assignCompanyPlanHandler(deps, ADMIN_AUTH,
    { companyId: 'legacy-co', planId: 'plan-old', allowDeprecatedPlanForMigration: true });
  check('narrow migration override assigns deprecated plan, distinctly audited',
    mig.planId === 'plan-old'
    && deps.audits().some((a) => a.operation === 'company.assignPlan.migrationOverride'));
  await denied('assign onto invalid existing contract rejected',
    H.assignCompanyPlanHandler(deps, ADMIN_AUTH, { companyId: 'broken-co', planId: 'plan-field' }),
    'failed-precondition');
}
{
  const deps = makeDeps(behaviorSeed);
  const r = await H.addEntitlementOverrideHandler(deps, ADMIN_AUTH, {
    companyId: 'configured-co', capability: 'billing', granted: true,
    reason: 'billing pilot', expiresAt: '2026-09-01T00:00:00.000Z',
  });
  const ovr = deps.store.get('companies/configured-co').wellbuiltContract.entitlementOverrides[0];
  check('override appended with server-derived actor + timestamp',
    r.configurationVersion === 2 && ovr.grantedBy === ADMIN_UID
    && ovr.grantedAt === new Date(NOW).toISOString() && ovr.capability === 'billing');
  await denied('override actor spoof rejected (grantedBy in body)',
    H.addEntitlementOverrideHandler(deps, ADMIN_AUTH, {
      companyId: 'configured-co', capability: 'jsa', granted: false, reason: 'x', grantedBy: 'someone',
    }), 'invalid-argument', 'unknown_fields:grantedBy');
  await denied('override without reason rejected',
    H.addEntitlementOverrideHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', capability: 'jsa', granted: false, reason: '  ' }),
    'invalid-argument', 'reason_missing_or_unbounded');
  await denied('override on legacy company rejected (assign plan first)',
    H.addEntitlementOverrideHandler(deps, ADMIN_AUTH, { companyId: 'legacy-co', capability: 'jsa', granted: true, reason: 'x' }),
    'failed-precondition', 'assign_plan_first');
  const rm = await H.removeEntitlementOverrideHandler(deps, ADMIN_AUTH,
    { companyId: 'configured-co', capability: 'billing', reason: 'pilot done' });
  check('override removed, version bumped', rm.removed === 1 && rm.configurationVersion === 3);
  await denied('remove nonexistent override rejected',
    H.removeEntitlementOverrideHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', capability: 'billing', reason: 'again' }),
    'not-found', 'no_override_for_capability');
}
{
  const deps = makeDeps(behaviorSeed);
  // Inert company with derived-mode config missing tz → enforcement refused.
  await H.setCompanyWorkPeriodConfigurationHandler(deps, ADMIN_AUTH,
    { companyId: 'configured-co', configuration: { mode: 'company_defined_period' } });
  await denied('enforcement refused with incomplete configuration',
    H.setCompanyContractEnforcementHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', enforced: true }),
    'failed-precondition');
  // Complete derived config but no capability entitlement → refused distinctly.
  await H.setCompanyWorkPeriodConfigurationHandler(deps, ADMIN_AUTH, {
    companyId: 'configured-co',
    configuration: { mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '06:00', durationMinutes: 720 },
  });
  await denied('enforcement refused when mode not entitled',
    H.setCompanyContractEnforcementHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', enforced: true }),
    'failed-precondition', 'not_enforceable:mode_not_entitled');
  await H.addEntitlementOverrideHandler(deps, ADMIN_AUTH, {
    companyId: 'configured-co', capability: 'companyDefinedWorkPeriod', granted: true, reason: 'derived pilot',
  });
  const en = await H.setCompanyContractEnforcementHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', enforced: true });
  check('enforcement allowed when complete + entitled (derived mode)',
    en.contractEnforced === true
    && deps.store.get('companies/configured-co').wellbuiltContract.contractEnforced === true);
  // Active contract cannot be reconfigured into an unusable state.
  await denied('active contract rejects breaking reconfiguration',
    H.setCompanyWorkPeriodConfigurationHandler(deps, ADMIN_AUTH,
      { companyId: 'configured-co', configuration: { mode: 'company_defined_period' } }),
    'failed-precondition');
  const off = await H.setCompanyContractEnforcementHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', enforced: false });
  check('un-enforce always allowed', off.contractEnforced === false);
}
{
  const deps = makeDeps(behaviorSeed);
  // Explicit mode enforcement on the seeded explicit contract.
  const en = await H.setCompanyContractEnforcementHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', enforced: true });
  check('enforcement allowed for complete explicit mode', en.contractEnforced === true);
  await denied('invalid timezone rejected at configuration time',
    H.setCompanyWorkPeriodConfigurationHandler(deps, ADMIN_AUTH,
      { companyId: 'configured-co', configuration: { mode: 'company_defined_period', timezone: 'Mars/Olympus', startLocalTime: '06:00', durationMinutes: 720 } }),
    'invalid-argument', 'work_period_invalid_timezone');
  await denied('invalid schedule rejected',
    H.setCompanyWorkPeriodConfigurationHandler(deps, ADMIN_AUTH,
      { companyId: 'configured-co', configuration: { mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '6am', durationMinutes: 720 } }),
    'invalid-argument', 'work_period_invalid_start_local_time');
}

// Replacement / archive.
{
  const deps = makeDeps(behaviorSeed);
  const r = await H.updateCompanySafeHandler(deps, ADMIN_AUTH,
    { companyId: 'configured-co', fields: { name: 'Configured LLC', phone: '701-555-0100' } });
  const co = deps.store.get('companies/configured-co');
  check('safe update merges fields, contract preserved',
    r.changedFields.length === 2 && co.name === 'Configured LLC'
    && co.wellbuiltContract.planId === 'plan-field');
  await denied('safe update rejects wellbuiltContract',
    H.updateCompanySafeHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', fields: { wellbuiltContract: {} } }),
    'permission-denied', 'protected_field:wellbuiltContract');
  await denied('safe update rejects reserved flat key (planId)',
    H.updateCompanySafeHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', fields: { planId: 'plan-god' } }),
    'permission-denied', 'protected_field:planId');
  await denied('safe update rejects dotted field path',
    H.updateCompanySafeHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', fields: { 'wellbuiltContract.planId': 'x' } }),
    'permission-denied', 'protected_field:wellbuiltContract.planId');
  await denied('safe update rejects empty field set',
    H.updateCompanySafeHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', fields: {} }),
    'invalid-argument', 'fields_empty_or_unbounded');

  await denied('archive requires exact confirmation',
    H.archiveCompanyHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', confirmCompanyId: 'configured-c', reason: 'closing' }),
    'failed-precondition', 'confirmation_mismatch');
  const a = await H.archiveCompanyHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', confirmCompanyId: 'configured-co', reason: 'closing' });
  const archived = deps.store.get('companies/configured-co');
  check('archive sets status + timestamp, contract intact',
    a.status === 'archived' && archived.status === 'archived'
    && archived.archivedAt === '<server-ts>' && archived.wellbuiltContract.planId === 'plan-field');
  await denied('double archive rejected',
    H.archiveCompanyHandler(deps, ADMIN_AUTH, { companyId: 'configured-co', confirmCompanyId: 'configured-co', reason: 'again' }),
    'failed-precondition', 'already_archived');
}

// Reads.
{
  const deps = makeDeps(behaviorSeed);
  for (const id of ['plan-a', 'plan-b', 'plan-c']) {
    await H.createPlanHandler(deps, ADMIN_AUTH, { planId: id, displayName: id, capabilities: [] });
  }
  const p1 = await H.listPlansHandler(deps, ADMIN_AUTH, { limit: 2 });
  check('listPlans page 1: capped + stable order + cursor',
    p1.plans.length === 2 && p1.plans[0].planId === 'plan-a' && p1.nextCursor === 'plan-b');
  const p2 = await H.listPlansHandler(deps, ADMIN_AUTH, { limit: 2, cursor: p1.nextCursor });
  check('listPlans page 2 continues after cursor', p2.plans[0].planId === 'plan-c');
  await denied('listPlans over-limit rejected',
    H.listPlansHandler(deps, ADMIN_AUTH, { limit: 51 }), 'invalid-argument', 'invalid_limit');
  await denied('listPlans invalid cursor rejected',
    H.listPlansHandler(deps, ADMIN_AUTH, { cursor: 'Bad Cursor!' }), 'invalid-argument', 'invalid_plan_id');

  const g = await H.getPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-field' });
  check('getPlan returns minimal typed plan',
    JSON.stringify(Object.keys(g.plan).sort()) ===
    JSON.stringify(['capabilities', 'contractVersion', 'displayName', 'planId', 'status']));
  await denied('getPlan unknown → not-found',
    H.getPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-none' }), 'not-found', 'plan_not_found');

  const legacy = await H.getCompanyContractConfigurationHandler(deps, ADMIN_AUTH, { companyId: 'legacy-co' });
  check('contract configuration: legacy surfaced as legacy', legacy.state === 'legacy' && legacy.contract === undefined);
  const broken = await H.getCompanyContractConfigurationHandler(deps, ADMIN_AUTH, { companyId: 'broken-co' });
  check('contract configuration: incompatible surfaced DISTINCTLY',
    broken.state === 'invalid' && broken.invalidReason.startsWith('unsupported_contract_version'));

  const prev = await H.previewCompanyEffectiveCapabilitiesHandler(deps, ADMIN_AUTH, { companyId: 'configured-co' });
  check('preview computes for configured company',
    prev.state === 'inert' && prev.result.ok === true
    && prev.result.capabilities.jsaEnabled === true
    && prev.result.capabilities.suiteLoginRequired === true);
  const prevBroken = await H.previewCompanyEffectiveCapabilitiesHandler(deps, ADMIN_AUTH, { companyId: 'broken-co' });
  check('preview surfaces incompatible contract distinctly', prevBroken.state === 'invalid');
}
{
  const deps = makeDeps(behaviorSeed);
  await H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-z', displayName: 'Z', capabilities: [] });
  await H.deprecatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-z' });
  const l = await H.listAdminAuditHandler(deps, ADMIN_AUTH, { limit: 1 });
  check('audit list: newest first, bounded, cursor',
    l.entries.length === 1 && l.entries[0].operation === 'plan.deprecate' && l.nextCursor !== null);
  const l2 = await H.listAdminAuditHandler(deps, ADMIN_AUTH, { limit: 1, cursor: l.nextCursor });
  check('audit list page 2', l2.entries.length === 1 && l2.entries[0].operation === 'plan.create');
  await denied('audit list invalid cursor rejected',
    H.listAdminAuditHandler(deps, ADMIN_AUTH, { cursor: 'DROP TABLE' }), 'invalid-argument', 'invalid_cursor');
  const allowedKeys = ['operation', 'targetType', 'targetId', 'actorUid', 'actorEmail', 'at',
    'contractVersion', 'adminPolicyVersion', 'reason', 'changedFields', 'auditId'];
  check('audit records carry ONLY the bounded allowlist (no payloads/tokens)',
    l.entries.every((e) => Object.keys(e).every((k) => allowedKeys.includes(k))));
}

// ── source pins ───────────────────────────────────────────────────────────
{
  const handlersSrc = readFileSync(join(root, 'functions/src/admin/adminHandlers.ts'), 'utf8');
  const exported = [...handlersSrc.matchAll(/export async function (\w+Handler)\(/g)].map((m) => m[1]);
  check('15 protected handlers exported', exported.length === 15, `found ${exported.length}`);
  const bodies = handlersSrc.split(/export async function /).slice(1)
    .filter((b) => b.slice(0, b.indexOf('(')).endsWith('Handler'));
  const unguarded = bodies.filter((b) => !b.includes('requireAdmin(deps, auth)')).map((b) => b.slice(0, b.indexOf('(')));
  check('every protected handler routes through requireAdmin', unguarded.length === 0,
    `unguarded: ${unguarded.join(',')}`);

  const callablesSrc = readFileSync(join(root, 'functions/src/admin/callables.ts'), 'utf8');
  const wrapped = [...callablesSrc.matchAll(/export const (admin\w+) = wrap\((\w+Handler)\)/g)];
  check('every handler wrapped exactly once as a callable',
    wrapped.length === 15 && new Set(wrapped.map((m) => m[2])).size === 15);
  check('callables centralize App Check preparation (enforceAppCheck flag present, off)',
    /enforceAppCheck:\s*false/.test(callablesSrc));

  const indexSrc = readFileSync(join(root, 'functions/src/index.ts'), 'utf8');
  const missing = wrapped.map((m) => m[1]).filter((name) => !indexSrc.includes(name));
  check('index.ts exports every admin callable', missing.length === 0, `missing: ${missing.join(',')}`);
}

// ── vc51.9L: administrative `apps` entitlement write support ──────────────
// Storage only. Nothing here enforces an entitlement — these tests pin
// that what an admin can WRITE is exactly what the canonical resolver can
// READ, and that nothing invalid ever reaches a document.
{
  const C = await import(
    pathToFileURL(require0.resolve('@tester3x/wellbuilt-contracts')).href);
  const TICKETS = C.WELLBUILT_APP_TICKETS;
  const MOBILE = C.WELLBUILT_APP_MOBILE;
  const SUITE = C.WELLBUILT_APP_SUITE;

  // ---- create: absence, empty, and valid maps -------------------------
  {
    const deps = makeDeps(behaviorSeed);
    await H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-legacy', displayName: 'L', capabilities: [] });
    const doc = deps.store.get('plans/plan-legacy');
    check('create: omitted apps stores a GENUINELY ABSENT field',
      !('apps' in doc));
    check('create: an omitted map reads back as legacy',
      C.resolveAppEntitlement(doc, TICKETS).outcome === 'LEGACY_UNCONFIGURED');
    check('create: omitted apps is not named as a changed field',
      !(deps.audits()[0].changedFields ?? []).includes('apps'));
  }
  {
    const deps = makeDeps(behaviorSeed);
    await H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-empty', displayName: 'E', capabilities: [], apps: {} });
    const doc = deps.store.get('plans/plan-empty');
    check('create: explicit {} is STORED, not dropped',
      'apps' in doc && typeof doc.apps === 'object' && doc.apps !== null
      && Object.keys(doc.apps).length === 0);
    check('create: {} authoritatively excludes destination apps',
      C.resolveAppEntitlement(doc, TICKETS).outcome === 'EXCLUDED');
    check('create: {} does NOT exclude core Suite',
      C.decideAppAccess(doc, SUITE, { hasActiveShift: false }).access === 'allowed');
    check('create: apps named as a changed field when supplied',
      (deps.audits()[0].changedFields ?? []).includes('apps'));
  }
  {
    const deps = makeDeps(behaviorSeed);
    await H.createPlanHandler(deps, ADMIN_AUTH, {
      planId: 'plan-apps', displayName: 'A', capabilities: [],
      apps: {
        [TICKETS]: { included: true, requiresActiveShift: true },
        [MOBILE]: { included: true },
        [C.WELLBUILT_APP_DASHBOARD]: { included: false },
      },
    });
    const doc = deps.store.get('plans/plan-apps');
    check('create: multiple valid entries stored',
      Object.keys(doc.apps).length === 3);
    check('create: each entry form round-trips through the resolver',
      C.resolveAppEntitlement(doc, TICKETS).outcome === 'INCLUDED_REQUIRES_ACTIVE_SHIFT'
      && C.resolveAppEntitlement(doc, MOBILE).outcome === 'INCLUDED_NO_SHIFT_REQUIRED'
      && C.resolveAppEntitlement(doc, C.WELLBUILT_APP_DASHBOARD).outcome === 'EXCLUDED');
    check('create: stores the CANONICAL normalized form (no requiresActiveShift:false)',
      !('requiresActiveShift' in doc.apps[MOBILE]));
    check('create: a redundant explicit Suite inclusion is accepted',
      C.validatePlanAppEntitlements({ [SUITE]: { included: true } }).ok === true);
  }

  // ---- create: every invalid shape is refused, atomically -------------
  const BAD = [
    ['null', null, 'malformed_entitlement_map'],
    ['an array', [], 'malformed_entitlement_map'],
    ['a string', 'all', 'malformed_entitlement_map'],
    ['a number', 1, 'malformed_entitlement_map'],
    ['a boolean', true, 'malformed_entitlement_map'],
    ['an unknown app key', { 'wellbuilt-payroll': { included: true } }, 'unknown_app:wellbuilt-payroll'],
    ['the wbt alias', { wbt: { included: true } }, 'unknown_app:wbt'],
    ['the water-ticket alias', { 'water-ticket': { included: true } }, 'unknown_app:water-ticket'],
    ['the wbew alias', { wbew: { included: true } }, 'unknown_app:wbew'],
    ['a malformed entry', { [TICKETS]: { included: 'yes' } }, `malformed_entitlement_entry:${TICKETS}`],
    ['a non-object entry', { [TICKETS]: 3 }, `malformed_entitlement_entry:${TICKETS}`],
    ['configuration data smuggled into an entry', { [TICKETS]: { included: true, enabled: false } }, `malformed_entitlement_entry:${TICKETS}`],
    ['a shift-gated exclusion', { [TICKETS]: { included: false, requiresActiveShift: true } }, `shift_requirement_on_excluded_app:${TICKETS}`],
    ['excluding core Suite', { [SUITE]: { included: false } }, `core_app_not_excludable:${SUITE}`],
    ['shift-gating core Suite', { [SUITE]: { included: true, requiresActiveShift: true } }, `shift_requirement_on_core_app:${SUITE}`],
  ];
  for (const [label, apps, reason] of BAD) {
    const deps = makeDeps(behaviorSeed);
    await denied(`create: ${label} rejected`,
      H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-bad', displayName: 'B', capabilities: [], apps }),
      'invalid-argument', `invalid_app_entitlements:${reason}`);
    check(`create: ${label} wrote NO plan and NO audit`,
      deps.store.get('plans/plan-bad') === undefined && deps.audits().length === 0);
  }
  {
    const deps = makeDeps(behaviorSeed);
    await denied('create: an unrelated unknown top-level key is still rejected',
      H.createPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-x', displayName: 'X', capabilities: [], apps: {}, tier: 'god' }),
      'invalid-argument', 'unknown_fields:tier');
  }

  // ---- update: omission preserves, valid replaces ---------------------
  const seedWithApps = {
    ...behaviorSeed,
    'plans/plan-configured': {
      contractVersion: 1, planId: 'plan-configured', displayName: 'Configured',
      capabilities: ['jsa'], status: 'active',
      apps: { [TICKETS]: { included: true, requiresActiveShift: true } },
    },
  };
  {
    const deps = makeDeps(seedWithApps);
    const before = JSON.stringify(deps.store.get('plans/plan-configured').apps);
    const r = await H.updatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-configured', displayName: 'Renamed' });
    check('update: omitted apps leaves a configured map byte-for-byte unchanged',
      JSON.stringify(deps.store.get('plans/plan-configured').apps) === before
      && !r.changedFields.includes('apps'));
  }
  {
    const deps = makeDeps(behaviorSeed);
    await H.updatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-field', displayName: 'Renamed' });
    check('update: omitted apps leaves a LEGACY plan still absent',
      !('apps' in deps.store.get('plans/plan-field')));
    check('update: the legacy plan still reads as unconfigured',
      C.resolveAppEntitlement(deps.store.get('plans/plan-field'), TICKETS).outcome
      === 'LEGACY_UNCONFIGURED');
  }
  {
    const deps = makeDeps(seedWithApps);
    const r = await H.updatePlanHandler(deps, ADMIN_AUTH, {
      planId: 'plan-configured', apps: { [MOBILE]: { included: true } },
    });
    const doc = deps.store.get('plans/plan-configured');
    check('update: a valid map REPLACES the previous map',
      Object.keys(doc.apps).length === 1 && MOBILE in doc.apps && !(TICKETS in doc.apps)
      && r.changedFields.includes('apps'));
    check('update: the replaced app is now excluded, the new one included',
      C.resolveAppEntitlement(doc, TICKETS).outcome === 'EXCLUDED'
      && C.resolveAppEntitlement(doc, MOBILE).outcome === 'INCLUDED_NO_SHIFT_REQUIRED');
  }
  {
    const deps = makeDeps(seedWithApps);
    await H.updatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-configured', apps: {} });
    const doc = deps.store.get('plans/plan-configured');
    check('update: {} replaces the previous map and stays authoritative',
      'apps' in doc && Object.keys(doc.apps).length === 0
      && C.resolveAppEntitlement(doc, TICKETS).outcome === 'EXCLUDED');
    check('update: {} still cannot take core Suite away',
      C.decideAppAccess(doc, SUITE, { hasActiveShift: false }).access === 'allowed');
  }
  {
    const deps = makeDeps(seedWithApps);
    check('update: apps alone is a sufficient updatable field',
      (await H.updatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-configured', apps: {} }))
        .changedFields.join(',') === 'apps');
  }

  // ---- update: invalid input changes nothing at all -------------------
  for (const [label, apps, reason] of BAD) {
    const deps = makeDeps(seedWithApps);
    const before = JSON.stringify(deps.store.get('plans/plan-configured'));
    await denied(`update: ${label} rejected`,
      H.updatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-configured', apps }),
      'invalid-argument', `invalid_app_entitlements:${reason}`);
    check(`update: ${label} left plan and audit state untouched`,
      JSON.stringify(deps.store.get('plans/plan-configured')) === before
      && deps.audits().length === 0);
  }
  {
    const deps = makeDeps(seedWithApps);
    await denied('update: a clear/unset via null is rejected, not treated as delete',
      H.updatePlanHandler(deps, ADMIN_AUTH, { planId: 'plan-configured', apps: null }),
      'invalid-argument', 'invalid_app_entitlements:malformed_entitlement_map');
    check('update: the configured map survives an attempted null clear',
      deps.store.get('plans/plan-configured').apps[TICKETS].included === true);
  }
  {
    const deps = makeDeps(seedWithApps);
    const r = await H.updatePlanHandler(deps, ADMIN_AUTH, {
      planId: 'plan-configured', displayName: 'Both', capabilities: ['dvir'], apps: {},
    });
    check('update: unrelated fields keep their previous behavior alongside apps',
      deps.store.get('plans/plan-configured').displayName === 'Both'
      && deps.store.get('plans/plan-configured').capabilities.join(',') === 'dvir'
      && r.changedFields.sort().join(',') === 'apps,capabilities,displayName');
  }

  // ---- read path: stored output is resolver-readable ------------------
  {
    const deps = makeDeps(seedWithApps);
    const got = await H.getPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-configured' });
    check('read: getPlan carries apps through to the caller',
      got.plan.apps && got.plan.apps[TICKETS].requiresActiveShift === true);
    check('read: the carried plan resolves identically to the stored doc',
      C.resolveAppEntitlement(got.plan, TICKETS).outcome === 'INCLUDED_REQUIRES_ACTIVE_SHIFT');
    const legacy = await H.getPlanHandler(deps, ADMIN_AUTH, { planId: 'plan-field' });
    check('read: a legacy plan keeps a genuinely absent field, not undefined-valued',
      !('apps' in legacy.plan));
    check('read: the legacy plan still resolves as unconfigured',
      C.resolveAppEntitlement(legacy.plan, TICKETS).outcome === 'LEGACY_UNCONFIGURED');
  }

  // ---- no local reimplementation of contract rules --------------------
  {
    const src = readFileSync(join(root, 'functions/src/admin/adminHandlers.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('handlers call the canonical validator',
      /validatePlanAppEntitlements\(/.test(src));
    check('handlers do NOT reimplement app keys, aliases, or entitlement rules',
      !/wellbuilt-tickets|water-ticket|WELLBUILT_APP_KEYS|requiresActiveShift|isCoreApp/.test(src));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
