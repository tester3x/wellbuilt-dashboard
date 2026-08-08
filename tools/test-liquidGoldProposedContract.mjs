/**
 * vc51.9AA — qualification of the PROPOSED Liquid Gold configuration.
 *
 * Read-only design proof. Nothing here writes, deploys, or invokes a
 * callable: it feeds the exact documents the proposed mutation sequence
 * would create into the real computeEffectiveCapabilities and the real
 * resolveWorkPeriod, and asserts the eleven required lifecycle properties
 * come out.
 *
 * The point is to fail HERE if the proposed configuration does not
 * actually produce the lifecycle Liquid Gold needs — before anything is
 * written to live data.
 *
 * Run: node tools/test-liquidGoldProposedContract.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const cap = await import(pathToFileURL(join(ROOT, 'functions/lib/admin/effectiveCapabilities.js')).href);
const pkg = await import(pathToFileURL(join(ROOT, 'functions/node_modules/@tester3x/wellbuilt-contracts/dist/index.js')).href);

// ── the exact documents the proposed sequence would create ───────────────
const PLAN = {
  contractVersion: 1,
  planId: 'liquid-gold-explicit',
  displayName: 'Liquid Gold Explicit Shift',
  capabilities: ['explicitShiftLifecycle', 'jsa', 'dvir'],
  status: 'active',
};
const CONTRACT = {
  contractVersion: 1,
  configurationVersion: 3,
  planId: 'liquid-gold-explicit',
  entitlementOverrides: [],
  workPeriodConfiguration: { mode: 'explicit_shift', timezone: 'America/Chicago' },
  contractEnforced: true,
};

const NOW = Date.parse('2026-08-09T14:00:00.000Z');
const r = cap.computeEffectiveCapabilities({ companyId: 'liquid-gold', plan: PLAN, contract: CONTRACT, nowMs: NOW });

check('the proposed contract computes at all', r.ok === true, JSON.stringify(r).slice(0, 200));
if (!r.ok) { console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = 1; }
else {
  const c = r.capabilities;
  console.log('  effective capabilities: ' + JSON.stringify(c));

  // ── requirement 1 + 4: explicit shift governs shift-scoped work ────────
  check('R1/R4. explicit-shift mode is in force', c.workPeriodMode === 'explicit_shift');
  check('R4. jobs require the active explicit period',
    c.explicitShiftRequiredBeforeJobs === true,
    'this is false unless the PLAN carries explicitShiftLifecycle');
  check('R1. suite login is required but is NOT a shift',
    c.suiteLoginRequired === true
    && pkg.requiresWorkPeriod(c, 'app_use') === false,
    'login must never imply a started shift');
  for (const a of ['wbt_job_start', 'jsa_request', 'equipment_dvir']) {
    check(`R4. ${a} requires the work period`, pkg.requiresWorkPeriod(c, a) === true);
  }
  check('the plan is not deprecated', r.planDeprecated === false);

  // ── requirement 8/9: no fixed hours, no derived rotation ───────────────
  check('R8/R9. no start hour or duration is configured',
    CONTRACT.workPeriodConfiguration.startLocalTime === undefined
    && CONTRACT.workPeriodConfiguration.durationMinutes === undefined);
  check('R9. the customer cannot introduce derived-period fields',
    Array.isArray(c.customerEditableFields) && c.customerEditableFields.length === 0,
    'explicit_shift exposes no derived knobs');

  // ── the resolver: the lifecycle itself ────────────────────────────────
  const base = {
    contractVersion: 1, companyId: 'liquid-gold', driverId: 'driver-1',
    capabilities: c,
    config: { contractVersion: 1, configurationVersion: 3, mode: 'explicit_shift', timezone: 'America/Chicago' },
  };
  const at = (iso) => Date.parse(iso);

  // R1: open shift today
  const open = pkg.resolveWorkPeriod({ ...base, nowMs: at('2026-08-09T20:00:00Z'),
    todayLocalDate: '2026-08-09',
    evidence: { today: { readable: true, present: true, currentShiftId: '2026-08-09_060000' } } });
  check('R1. an open shift today resolves ACTIVE', open.outcome === 'ACTIVE_EXPLICIT_SHIFT', open.outcome);
  check('R1. and is operationally open', pkg.isOperationallyOpen(open) === true);

  // R2: survives midnight — today's doc absent, origin day still names it
  const overnight = pkg.resolveWorkPeriod({ ...base, nowMs: at('2026-08-10T08:00:00Z'),
    todayLocalDate: '2026-08-10',
    evidence: {
      today: { readable: true, present: false },
      cachedShiftId: '2026-08-09_180000',
      cachedOriginDay: { readable: true, present: true, currentShiftId: '2026-08-09_180000' },
    } });
  check('R2. an overnight shift survives midnight',
    overnight.outcome === 'ACTIVE_EXPLICIT_SHIFT', overnight.outcome);
  check('R2. it keeps its ORIGINAL period id (no replacement minted)',
    overnight.periodId === '2026-08-09_180000', String(overnight.periodId));
  check('R2/R7. the period is sourced from its own origin day',
    overnight.source === 'authoritative_origin_day', overnight.source);

  // R3: survives restart — cache is a hint, origin day is authority
  check('R3. a restart with only a cached id still resolves from authority',
    overnight.source === 'authoritative_origin_day',
    'the cached id alone proves nothing; the day doc confirmed it');
  const cacheLies = pkg.resolveWorkPeriod({ ...base, nowMs: at('2026-08-10T08:00:00Z'),
    todayLocalDate: '2026-08-10',
    evidence: {
      today: { readable: true, present: false },
      cachedShiftId: '2026-08-09_180000',
      cachedOriginDay: { readable: true, present: true, currentShiftId: '2026-08-09_235959' },
    } });
  check('R3. a superseded cached id is NOT reopened',
    cacheLies.outcome === 'CLOSED_OR_SUPERSEDED', cacheLies.outcome);

  // R6: explicit close ends it
  const closed = pkg.resolveWorkPeriod({ ...base, nowMs: at('2026-08-09T23:00:00Z'),
    todayLocalDate: '2026-08-09',
    evidence: { today: { readable: true, present: true, currentShiftId: '' } } });
  check('R6. an explicitly closed shift is not active',
    closed.outcome !== 'ACTIVE_EXPLICIT_SHIFT', closed.outcome);
  check('R6. and is not operationally open', pkg.isOperationallyOpen(closed) === false);

  // R10/R11: duration never closes a period
  const long = pkg.resolveWorkPeriod({ ...base, nowMs: at('2026-08-11T12:00:00Z'),
    todayLocalDate: '2026-08-11',
    evidence: {
      today: { readable: true, present: false },
      cachedShiftId: '2026-08-09_060000',
      cachedOriginDay: { readable: true, present: true, currentShiftId: '2026-08-09_060000' },
    } });
  check('R10. a 54-hour period is still OPEN — duration never blocks',
    long.outcome === 'ACTIVE_EXPLICIT_SHIFT', long.outcome);

  // offline must never fabricate an open period
  const offline = pkg.resolveWorkPeriod({ ...base, nowMs: at('2026-08-09T20:00:00Z'),
    todayLocalDate: '2026-08-09',
    evidence: { today: { readable: false, present: false }, cachedShiftId: '2026-08-09_060000' } });
  check('offline authority yields UNVERIFIED, never open',
    offline.outcome === 'UNVERIFIED_OFFLINE' && pkg.isOperationallyOpen(offline) === false,
    offline.outcome);
  check('an unverified period may not bind request evidence',
    pkg.mayBindRequestEvidence(offline) === false);

  // ── the negative control: the same contract WITHOUT the capability ─────
  const weakPlan = { ...PLAN, capabilities: ['jsa', 'dvir'] };
  const weak = cap.computeEffectiveCapabilities({ companyId: 'liquid-gold', plan: weakPlan, contract: CONTRACT, nowMs: NOW });
  check('NEGATIVE CONTROL: without explicitShiftLifecycle the lifecycle silently does not apply',
    weak.ok === true && weak.capabilities.explicitShiftRequiredBeforeJobs === false
    && pkg.requiresWorkPeriod(weak.capabilities, 'wbt_job_start') === false,
    'proves the capability is load-bearing, not decorative');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
