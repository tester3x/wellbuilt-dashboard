/**
 * vc51.9Y — a failed contract load must not re-enter itself.
 *
 * reload()'s catch calls surface(err). surface() consults errorGuidance()
 * and, when the guidance action is 'reload', calls reload() again. For a
 * mutation that is correct: refresh the stale view. But reload() is the
 * caller here, so a load that fails with not_found or conflict — exactly
 * what adminGetCompanyContractConfiguration returns for a company with no
 * contract document (company_not_found -> not-found -> kind not_found ->
 * action 'reload') — re-enters reload from its own catch, fails again,
 * and calls itself again. Nothing bounds it: no attempt counter, no
 * in-flight guard, no backoff. The panel issues callable requests in a
 * tight loop for as long as the row stays open.
 *
 * The load path must report and stop. Recovery is the operator's Retry
 * button, which is already there.
 *
 * Run: node tools/test-contractPanelNoReloadLoop.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const raw = readFileSync(join(ROOT, 'src/components/admin/CompanyContractPanel.tsx'), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── 1. the load failure path must not re-enter reload ────────────────────
{
  // Bound the slice to reload()'s catch block, ending at the hook's own
  // dependency array. Comments are stripped above, so a comment marker is
  // not a usable delimiter.
  const s = code.indexOf('} catch (err) {', code.indexOf('const reload'));
  const e = code.indexOf('}, [companyId]);', s);
  check('the reload catch block is bounded', s > 0 && e > s, `slice ${s}..${e}`);
  const block = code.slice(s, e === -1 ? s + 800 : e);

  check('1. the load-failure path does not call surface()',
    !/surface\(/.test(block),
    'surface() re-enters reload() whenever the guidance action is reload');
  check('1. the load-failure path does not call reload() itself',
    !/reload\(\)/.test(block));
  check('1. the load failure is still reported to the operator',
    /setLoadError\(/.test(block) && /contractLoadFailure\(/.test(block));
  check('1. the load failure still ends in the error phase',
    /setLoadPhase\('error'\)/.test(block));
}

// ── 1b. NO path inside reload() may route through surface() ──────────────
// The preview failure is caught inside reload()'s own try block, so it is
// the same trap: previewCompanyEffectiveCapabilities rejecting with a
// stale-state error would auto-reload the function it is running inside.
{
  const s = code.indexOf('const reload');
  const e = code.indexOf('}, [companyId]);', s);
  const whole = code.slice(s, e === -1 ? s + 2000 : e);
  check('1b. reload() never calls surface() anywhere in its body',
    !/surface\(/.test(whole),
    'including the preview catch, which runs inside reload()');
  check('1b. a preview failure is still reported',
    /catch \(previewErr\)/.test(whole) && /setNotice\(|reportOnly\(/.test(whole));
}

// ── 2. surface() keeps its auto-reload for MUTATIONS ─────────────────────
// The behaviour is right there and wrong in the load path; do not delete it.
check('2. surface still refreshes a stale view after a mutation',
  /action === 'reload'/.test(code) && /void reload\(\)/.test(code),
  'the mutation path legitimately reloads on a stale-state error');
{
  const s = code.indexOf('const run =');
  const e = code.indexOf('const view =', s);
  const runBlock = code.slice(s, e === -1 ? s + 700 : e);
  check('2. the mutation path still surfaces its errors',
    /surface\(err\)/.test(runBlock));
}

// ── 3. behaviour: a not_found load must issue exactly one read ───────────
const probePath = join(ROOT, 'tools', '.noReloadLoop.probe.mts');
let r = null;
try {
  writeFileSync(probePath, `
    import { contractLoadFailure } from '../src/lib/adminLoadFailure';
    import { AdminServiceError } from '../src/lib/adminContractServiceCore';

    // The guidance that drives surface()'s auto-reload. If these actions
    // are 'reload', routing a LOAD failure through surface() is a loop.
    const looping = ['not_found', 'conflict'].map((k) => ({
      kind: k,
      action: contractLoadFailure(new AdminServiceError(k as never, null)).action,
    }));
    console.log(JSON.stringify({ looping }));
  `, 'utf8');
  r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
  }).trim().split('\n').pop());
} catch (e) {
  check('guidance probe ran', false, String(e.message).slice(0, 200));
} finally {
  try { rmSync(probePath); } catch { /* best effort */ }
}

if (r) {
  check('3. the looping guidance actions are real, not hypothetical',
    r.looping.every((x) => x.action === 'reload'),
    JSON.stringify(r.looping));
  check('3. company_not_found is one of them',
    r.looping.some((x) => x.kind === 'not_found' && x.action === 'reload'),
    'adminGetCompanyContractConfiguration returns not-found/company_not_found');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
