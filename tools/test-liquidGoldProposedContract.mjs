/**
 * vc51.9AA — qualification of the LOCKED Liquid Gold configuration.
 *
 * Read-only design proof. Nothing here writes to Firestore, deploys, or
 * invokes a callable. It does two things:
 *
 *   1. Runs the REAL handlers (createPlan → assignCompanyPlan →
 *      setCompanyWorkPeriodConfiguration → setCompanyContractEnforcement)
 *      against an in-memory AdminDeps seeded with a Liquid-Gold-shaped
 *      company document, so the mutation sequence, the
 *      configurationVersion progression, the audit operations and the
 *      field-merge behaviour are OBSERVED rather than asserted from
 *      reading the source.
 *
 *   2. Feeds the resulting contract into the real
 *      computeEffectiveCapabilities and resolveWorkPeriod to prove the
 *      lifecycle Liquid Gold requires actually falls out.
 *
 * LOCKED DECISIONS (2026-08-08):
 *   planId              explicit-shift-standard   (reusable, not per-company)
 *   displayName         Explicit Shift Standard
 *   capabilities        explicitShiftLifecycle, jsa, dvir
 *   excluded            dispatch, billing — no consumer exists yet
 *   workPeriodConfig    { mode: 'explicit_shift' }   — timezone OMITTED
 *   overrides           none
 *   tier                untouched and inert
 *   rollback            enforcement-off, never contract deletion
 *
 * Timezone is omitted deliberately: the canonical package documents
 * timezone/startLocalTime/durationMinutes as derived-mode fields, and
 * isWorkPeriodConfigurationComplete returns complete for explicit_shift
 * with none of them. If omitting it broke any validator this harness
 * would fail here rather than the configuration being silently widened.
 *
 * Run: node tools/test-liquidGoldProposedContract.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const lib = (p) => pathToFileURL(join(ROOT, 'functions/lib', p)).href;

const H = await import(lib('admin/adminHandlers.js'));
const CC = await import(lib('admin/companyContract.js'));
const CAP = await import(lib('admin/effectiveCapabilities.js'));
const pkg = await import(pathToFileURL(join(ROOT, 'functions/node_modules/@tester3x/wellbuilt-contracts/dist/index.js')).href);

// ── locked payloads ──────────────────────────────────────────────────────
const PLAN_PAYLOAD = {
  planId: 'explicit-shift-standard',
  displayName: 'Explicit Shift Standard',
  capabilities: ['explicitShiftLifecycle', 'jsa', 'dvir'],
};
const WPC_PAYLOAD = { mode: 'explicit_shift' };   // timezone deliberately absent

// ── in-memory AdminDeps ──────────────────────────────────────────────────
// The 45 real Liquid Gold top-level keys, so the field-merge claim is
// tested against the actual document shape rather than a toy.
const LG_KEYS = ['adminUsers','companyContacts','allowedDisposals','aiPhotoAdvisoryMode','logoUrl',
  'allowedWells','currentDieselPrice','primaryColor','invoiceStartNumber','cancelledNumberHandling',
  'paymentTerms','rateSheet','city','liveDispatchSync','invoiceBook','invoicingMode','roleCapabilities',
  'billingConfig','state','splitTickets','address','invoicePrefix','transferRequiresApproval','jsaMode',
  'phone','tier','activePackages','assignedOperators','customJobTypes','sendLevelToDispatch','roleLabels',
  'rateSheets','levelReportTemplate','thermalLogoUrl','ticketPrefix','payConfig','midnightCutoff',
  'shortCode','wellMonitoring','name','createdAt','requirePhotos','emergencyContacts','ticketTemplates','zip'];

const ADMIN_UID = 'UID-ADMIN';
const AUTH = { uid: ADMIN_UID, token: { wellbuiltAdmin: true, email: 'admin@example.com' } };

const store = new Map();
store.set(`platform_admins/${ADMIN_UID}`, { enabled: true, policyVersion: 1 });
store.set('companies/liquid-gold', Object.fromEntries(
  LG_KEYS.map((k) => [k, k === 'tier' ? 'god' : k === 'name' ? 'Liquid Gold Trucking LLC' : `v:${k}`])));

let auditSeq = 0;
const audits = [];
const snap = (p) => (store.has(p) ? { exists: true, data: store.get(p) } : { exists: false });
const deps = {
  getDoc: async (p) => snap(p),
  runTransaction: async (fn) => {
    const writes = [];
    const tx = {
      get: async (p) => snap(p),
      update: (p, fields) => {
        if (!store.has(p)) throw new Error(`update on missing doc ${p}`);
        writes.push(() => store.set(p, { ...store.get(p), ...fields }));
      },
      create: (p, data) => {
        if (store.has(p)) throw new Error(`create on existing doc ${p}`);
        writes.push(() => store.set(p, data));
      },
    };
    const out = await fn(tx);
    writes.forEach((w) => w());              // commit only on success
    return out;
  },
  listDocsById: async () => [],
  newAuditId: () => `audit-${String(++auditSeq).padStart(4, '0')}`,
  serverTimestamp: () => 'SERVER_TS',
  nowMs: () => Date.parse('2026-08-09T14:00:00.000Z'),
};
const contractOf = () => store.get('companies/liquid-gold').wellbuiltContract;
const collectAudits = () => [...store.entries()]
  .filter(([k]) => k.startsWith('platform_admin_audit/'))
  .sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);

// ── 1. plan id validation ────────────────────────────────────────────────
check('1. explicit-shift-standard satisfies PLAN_ID_RE',
  CC.PLAN_ID_RE.test(PLAN_PAYLOAD.planId), String(CC.PLAN_ID_RE));
check('1. the rejected company-specific alternative was also legal (choice, not constraint)',
  CC.PLAN_ID_RE.test('liquid-gold-explicit'));

// ── 2. the stored-schema validator, with timezone OMITTED ────────────────
{
  const parsed = CC.parseStoredWorkPeriodConfiguration(WPC_PAYLOAD);
  check('2. { mode:"explicit_shift" } passes the real stored-schema validator',
    parsed.ok === true, JSON.stringify(parsed));
  check('2. and the parsed result carries NO timezone key',
    parsed.ok && !('timezone' in parsed.config), JSON.stringify(parsed.config));
  check('2. completeness holds for explicit_shift without any derived field',
    CC.isWorkPeriodConfigurationComplete({ mode: 'explicit_shift' }).complete === true);
  // The inverse, so the omission is shown to be mode-specific rather than lax.
  const derived = CC.isWorkPeriodConfigurationComplete({ mode: 'company_defined_period' });
  check('2. the same omission WOULD be incomplete in derived mode',
    derived.complete === false && /timezone/.test(derived.reason), JSON.stringify(derived));
}

// ── 8/9/10/11. run the real handlers in the exact locked sequence ────────
const r1 = await H.createPlanHandler(deps, AUTH, PLAN_PAYLOAD);
check('8. step 1 creates plans/explicit-shift-standard',
  r1.planId === 'explicit-shift-standard' && r1.status === 'active'
  && store.has('plans/explicit-shift-standard'));
check('8. the stored plan carries exactly the locked capabilities',
  JSON.stringify(store.get('plans/explicit-shift-standard').capabilities)
    === JSON.stringify(['explicitShiftLifecycle', 'jsa', 'dvir']));

const r2 = await H.assignCompanyPlanHandler(deps, AUTH,
  { companyId: 'liquid-gold', planId: 'explicit-shift-standard' });
check('9. assignment produces configurationVersion 1', r2.configurationVersion === 1);
check('8. assignment creates an INERT contract',
  contractOf().contractEnforced === false && contractOf().planId === 'explicit-shift-standard');

const r3 = await H.setCompanyWorkPeriodConfigurationHandler(deps, AUTH,
  { companyId: 'liquid-gold', configuration: WPC_PAYLOAD });
check('9. work-period configuration produces version 2', r3.configurationVersion === 2);
check('8. the stored configuration is exactly { mode:"explicit_shift" }',
  JSON.stringify(contractOf().workPeriodConfiguration) === JSON.stringify({ mode: 'explicit_shift' }),
  JSON.stringify(contractOf().workPeriodConfiguration));

const r4 = await H.setCompanyContractEnforcementHandler(deps, AUTH,
  { companyId: 'liquid-gold', enforced: true });
check('9. enforcement produces version 3', r4.configurationVersion === 3);
check('3. the contract is enforceable — assertEnforceable accepted it',
  r4.contractEnforced === true);

// ── 10. the exact four audit actions, in order ───────────────────────────
{
  const ops = collectAudits().map((a) => a.operation);
  check('10. exactly four audit records were written', ops.length === 4, ops.join(' , '));
  check('10. the operations are the expected four, in order',
    JSON.stringify(ops) === JSON.stringify(['plan.create', 'company.assignPlan',
      'company.setWorkPeriodConfiguration', 'company.enforceContract']),
    ops.join(' -> '));
  check('10. every audit names the verified actor and server time',
    collectAudits().every((a) => a.actorUid === ADMIN_UID && a.at === 'SERVER_TS'));
}

// ── 11. the 45 unrelated fields survive the single-root-key merge ────────
{
  const doc = store.get('companies/liquid-gold');
  const missing = LG_KEYS.filter((k) => !(k in doc));
  const mutated = LG_KEYS.filter((k) => k !== 'tier' && k !== 'name' && doc[k] !== `v:${k}`);
  check('11. all 45 pre-existing top-level fields are still present',
    missing.length === 0, missing.join(','));
  check('11. none of their values changed', mutated.length === 0, mutated.join(','));
  check('11. tier is untouched and inert', doc.tier === 'god');
  check('11. exactly one key was added', Object.keys(doc).length === LG_KEYS.length + 1
    && 'wellbuiltContract' in doc, String(Object.keys(doc).length));
}

// ── final contract shape ─────────────────────────────────────────────────
const FINAL = contractOf();
console.log('  FINAL wellbuiltContract: ' + JSON.stringify(FINAL));
check('the final contract has exactly the six schema keys',
  JSON.stringify(Object.keys(FINAL).sort())
    === JSON.stringify(['configurationVersion', 'contractEnforced', 'contractVersion',
      'entitlementOverrides', 'planId', 'workPeriodConfiguration']));
check('7. no entitlement override was needed', FINAL.entitlementOverrides.length === 0);
check('the stored contract re-parses as ACTIVE',
  CC.parseCompanyContract(FINAL).state === 'active', JSON.stringify(CC.parseCompanyContract(FINAL)).slice(0, 120));

// ── 4/5/6. effective capabilities and lifecycle ──────────────────────────
const eff = CAP.computeEffectiveCapabilities({
  companyId: 'liquid-gold',
  plan: { contractVersion: 1, ...PLAN_PAYLOAD, status: 'active' },
  contract: FINAL,
  nowMs: deps.nowMs(),
});
check('3. effective capabilities compute', eff.ok === true, JSON.stringify(eff).slice(0, 160));
if (eff.ok) {
  const c = eff.capabilities;
  console.log('  effective capabilities: ' + JSON.stringify(c));
  check('4. explicitShiftLifecycle governs job start',
    c.explicitShiftRequiredBeforeJobs === true && pkg.requiresWorkPeriod(c, 'wbt_job_start') === true);
  check('4. it governs JSA requests', pkg.requiresWorkPeriod(c, 'jsa_request') === true);
  check('4. it governs DVIR', pkg.requiresWorkPeriod(c, 'equipment_dvir') === true);
  check('4. but ordinary app use still needs no period',
    pkg.requiresWorkPeriod(c, 'app_use') === false && c.suiteLoginRequired === true);
  check('5. JSA remains enabled', c.jsaEnabled === true);
  check('5. DVIR remains enabled', c.dvirEnabled === true);
  check('6. dispatch and billing are excluded from the plan',
    !PLAN_PAYLOAD.capabilities.includes('dispatch') && !PLAN_PAYLOAD.capabilities.includes('billing'));
  check('6. and no capability leaked in via an override', eff.overrideAdjusted.length === 0);
  check('the omitted timezone yields no customer-editable derived fields',
    c.customerEditableFields.length === 0);

  // lifecycle, through the real resolver
  const base = { contractVersion: 1, companyId: 'liquid-gold', driverId: 'driver-1',
    capabilities: c, config: CC.toContractsWorkPeriodConfiguration(FINAL) };
  check('the materialized resolver config omits timezone too',
    !('timezone' in base.config), JSON.stringify(base.config));

  const overnight = pkg.resolveWorkPeriod({ ...base, nowMs: Date.parse('2026-08-10T08:00:00Z'),
    todayLocalDate: '2026-08-10',
    evidence: { today: { readable: true, present: false }, cachedShiftId: '2026-08-09_180000',
      cachedOriginDay: { readable: true, present: true, currentShiftId: '2026-08-09_180000' } } });
  check('midnight is survived with the ORIGINAL period id, timezone absent',
    overnight.outcome === 'ACTIVE_EXPLICIT_SHIFT' && overnight.periodId === '2026-08-09_180000',
    overnight.outcome);
  const long = pkg.resolveWorkPeriod({ ...base, nowMs: Date.parse('2026-08-11T12:00:00Z'),
    todayLocalDate: '2026-08-11',
    evidence: { today: { readable: true, present: false }, cachedShiftId: '2026-08-09_060000',
      cachedOriginDay: { readable: true, present: true, currentShiftId: '2026-08-09_060000' } } });
  check('7. a 54-hour period is still open — no maximum duration', long.outcome === 'ACTIVE_EXPLICIT_SHIFT');
  const closed = pkg.resolveWorkPeriod({ ...base, nowMs: Date.parse('2026-08-09T23:00:00Z'),
    todayLocalDate: '2026-08-09', evidence: { today: { readable: true, present: true, currentShiftId: '' } } });
  check('an explicit close ends the period', pkg.isOperationallyOpen(closed) === false);
  const offline = pkg.resolveWorkPeriod({ ...base, nowMs: Date.parse('2026-08-09T20:00:00Z'),
    todayLocalDate: '2026-08-09',
    evidence: { today: { readable: false, present: false }, cachedShiftId: '2026-08-09_060000' } });
  check('offline authority yields UNVERIFIED, never open',
    offline.outcome === 'UNVERIFIED_OFFLINE' && pkg.isOperationallyOpen(offline) === false);

  // negative control — the capability is load-bearing, not decorative
  const weak = CAP.computeEffectiveCapabilities({ companyId: 'liquid-gold',
    plan: { contractVersion: 1, ...PLAN_PAYLOAD, capabilities: ['jsa', 'dvir'], status: 'active' },
    contract: FINAL, nowMs: deps.nowMs() });
  check('NEGATIVE CONTROL: without explicitShiftLifecycle nothing requires a period',
    weak.ok && weak.capabilities.explicitShiftRequiredBeforeJobs === false
    && pkg.requiresWorkPeriod(weak.capabilities, 'wbt_job_start') === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
