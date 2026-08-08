/**
 * vc51.9Z-6 — the plans list must not invite a duplicate create after a
 * failed read.
 *
 * Found during deployment qualification of the eleven undeployed admin
 * callables. PlansTab keys its empty state on `plans.length === 0`, and
 * `plans` is only replaced on success — so any failed read renders:
 *
 *   "No plans exist yet. Create the first plan to begin assigning companies."
 *
 * This is the third surface with the same defect (contract panel, audit
 * tab, now plans), but it is the most consequential of the three. The
 * other two merely under-report. This one issues an instruction: it tells
 * the administrator to create the first plan at exactly the moment the
 * client has no idea what exists. Acting on it against a non-empty
 * catalog means attempting a create that the server will refuse with
 * plan_already_exists — or, worse, choosing a different planId and
 * genuinely duplicating a catalog entry.
 *
 * The empty-state copy must be reachable only from a read that succeeded.
 *
 * Today the live read does succeed and the catalog genuinely is empty, so
 * the message is currently true. It is true by luck, not by construction.
 *
 * Run: node tools/test-plansTabLoadState.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const raw = readFileSync(join(ROOT, 'src/components/admin/PlansTab.tsx'), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── THE defect: the instruction must require a successful read ───────────
{
  const CLAIM = 'No plans exist yet';
  let i = code.indexOf(CLAIM), n = 0, unguarded = 0;
  while (i !== -1) {
    n++;
    if (!/loadPhase === 'ready'/.test(code.slice(Math.max(0, i - 140), i))) unguarded++;
    i = code.indexOf(CLAIM, i + 1);
  }
  check('1. the "create the first plan" instruction is guarded by a successful read',
    n > 0 && unguarded === 0,
    `${n} occurrence(s), ${unguarded} unguarded`);
}

check('2. an explicit load phase exists',
  /loadPhase|'loading'\s*\|\s*'ready'\s*\|\s*'error'/.test(code));

check('3. a failed read renders an error state, not an empty catalog',
  /loadPhase === 'error'/.test(code));

check('4. the failure is recoverable without a page reload',
  /Retry/.test(code) && /onClick=\{[^}]*(load|refresh)/i.test(code));

check('5. the failure text does not assert anything about what exists',
  !/No plans exist[\s\S]{0,80}loadPhase === 'error'/.test(code));

// ── 9. the load path must not re-enter itself ────────────────────────────
// surface() calls load(true) whenever the guidance action is 'reload'.
// After a mutation that is correct. Called from load()'s own catch it is
// unbounded: not_found and conflict both carry that action.
{
  const s = code.indexOf('const load = useCallback');
  const e = code.indexOf('}, [cursor]);', s);
  const body = code.slice(s, e === -1 ? s + 1200 : e);
  check('9. the load path does not route failures through surface()',
    !/surface\(/.test(body),
    'surface() re-enters load() from load()\'s own catch');
  check('9. the load failure is still reported',
    /setNotice\(|reportOnly\(/.test(body) && /setLoadPhase\('error'\)/.test(body));
}
check('9. surface keeps its auto-reload for MUTATIONS',
  /action === 'reload'/.test(code) && /void load\(true\)/.test(code),
  'the mutation path legitimately refreshes a stale list');

// ── the mutation paths keep their truthful notices ───────────────────────
check('6. create/update still report success by planId',
  /Created plan \$\{formPlanId\}|Updated plan \$\{editing\.planId\}/.test(code));
check('7. deprecate still states the consequence for assigned companies',
  /Assigned companies are unaffected/.test(code));
check('8. mutation failures are surfaced through the shared guidance',
  /errorGuidance\(/.test(code));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
