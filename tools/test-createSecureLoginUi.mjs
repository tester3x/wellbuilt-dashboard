/**
 * vc51.9W — the Create-secure-login action, wired into DriversTab.
 *
 * These rows come from RTDB drivers/approved/{hash}, where the key IS the
 * passcode hash and WB-S's legacy login persisted driverId = hash. So the
 * UI must never offer a "reset" against that key, and the request it builds
 * must carry no credential-derived material. The deployed callable owns
 * name-conflict enforcement, so the client performs no index read at all.
 *
 * Structural coverage of the wiring; behavioural coverage of the request
 * and gating lives in test-secureLoginProvisioning.mjs (20 checks).
 *
 * Run: node tools/test-createSecureLoginUi.mjs
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

const tab = readFileSync(join(ROOT, 'src/components/admin/DriversTab.tsx'), 'utf8');
const code = tab.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── 1/2. the right action, and only the right action ─────────────────────
check('1. an eligible legacy row shows "Create secure login"',
  /credentialActionFor\(driver\) === 'create_secure_login'[\s\S]{0,400}Create secure login/.test(code));
check('2. no "Reset passcode" action is rendered in this tranche',
  !/Reset passcode/i.test(code));

// ── 3/4/5/17. request boundary ───────────────────────────────────────────
check('the request is built by the tested decision layer',
  /buildSetPasscodeRequest\(secureTarget, securePass\)/.test(code));
{
  // Nothing may hand a driverId/legacyHash to the callable from this file.
  // Bound the slice by the handler's own dependency array — comments are
  // stripped above, so a comment marker is not a usable delimiter.
  const s = code.indexOf('handleCreateSecureLogin');
  const e = code.indexOf('[secureTarget, secureBusy', s);
  const handler = code.slice(s, e === -1 ? s + 3000 : e);
  check('handler slice is bounded', e > s, `end marker at ${e}`);
  check('3/4. the component never supplies driverId or legacyHash',
    !/driverId\s*:/.test(handler) && !/legacyHash/.test(handler));
  check('17. no history or profile identifiers are added to the request',
    !/assignedRoutes|assignedCustomers|passcodeHash|\.key\b/.test(handler));
}
check('5. temporary:false comes from the decision layer, not the UI',
  !/temporary\s*:/.test(code),
  'the component must not set temporary itself');

// ── no client-side index read ────────────────────────────────────────────
check('the component reads neither driver_name_index nor driver_credentials',
  !/driver_name_index|driver_credentials/.test(code));

// ── 9. double submission ─────────────────────────────────────────────────
check('9. an in-flight submit is refused re-entry',
  /if \(!secureTarget \|\| secureBusy\) return;/.test(code));
check('9. the submit control is disabled while pending',
  /disabled=\{!canSubmit\(\{ passcode: securePass, confirm: secureConfirm, submitting: secureBusy \}\)\}/.test(code));

// ── 7/8. validation gating ───────────────────────────────────────────────
check('7/8. submission is gated by the shared canSubmit predicate',
  /canSubmit\(\{ passcode: securePass, confirm: secureConfirm, submitting: secureBusy \}\)/.test(code));
check('mismatch and policy problems are surfaced to the admin',
  /Passwords do not match/.test(code) && /localPolicyError\(securePass\)/.test(code));

// ── 10/11/12/13. secret lifetime ─────────────────────────────────────────
check('10. cancel clears the secret fields',
  /onClick=\{closeSecureModal\}/.test(code) && /clearSecureSecrets\(\)/.test(code));
check('11. success clears the secret fields before showing the result',
  /clearSecureSecrets\(\);\s*setSecureDone\(/.test(code));
check('12/13. switching rows or unmounting clears secrets',
  /useEffect\(\(\) => \{\s*clearSecureSecrets\(\);[\s\S]{0,120}return clearSecureSecrets;\s*\}, \[secureTarget/.test(code));

// ── 14. safe conflict message ────────────────────────────────────────────
check('14. already-exists renders the approved conflict copy',
  /already-exists/.test(code)
  && /That login name is already assigned to another secure driver\./.test(code));
{
  // Scope to the conflict copy itself — a file-wide search matches
  // unrelated attributes such as placeholder="Search drivers...".
  const msg = 'That login name is already assigned to another secure driver.';
  check('the conflict message reveals no holder or credential state',
    code.includes(msg)
    && !/(owned by|belongs to|current holder|existing driverId)/i.test(msg));
}

// ── 15. authorization ────────────────────────────────────────────────────
check('15. the action is gated by the existing isWbAdmin boundary',
  /\{isWbAdmin && credentialActionFor\(driver\)/.test(code));
check('15. server denial is surfaced, not bypassed',
  /permission-denied\|unauthenticated/.test(code));
check('no client-side substitute for server authorization is introduced',
  !/localStorage\.getItem\(['"](role|admin)/.test(code));

// ── 16/18. secret containment ────────────────────────────────────────────
check('16. no console logging in the secure-login path',
  !/console\.(log|warn|error|info|debug)\([^)]*secure(Pass|Confirm)/i.test(code));
check('16. the password never reaches storage, URLs, or the clipboard',
  !/localStorage[\s\S]{0,40}securePass|sessionStorage[\s\S]{0,40}securePass|clipboard[\s\S]{0,60}securePass|location[\s\S]{0,40}securePass/.test(code));
check('18. the raw server error is never rendered',
  !/\{secureError\s*\|\|\s*String\(err/.test(code)
  && !/setSecureError\(\s*(String\()?err/.test(code),
  'only our own sanitized copy may reach the DOM');
check('the success panel shows no password',
  !/setSecureDone\([^)]*securePass/.test(code));

// ── inputs are masked ────────────────────────────────────────────────────
{
  const pw = (code.match(/type="password"/g) || []).length;
  check('both fields are masked', pw >= 2, `${pw} masked input(s)`);
  check('browser password managers are told this is a new credential',
    (code.match(/autoComplete="new-password"/g) || []).length >= 2);
}

// ── the decision layer is unchanged ──────────────────────────────────────
{
  const probePath = join(ROOT, 'tools', '.createSecureLoginUi.probe.mts');
  try {
    writeFileSync(probePath, `
      import { buildSetPasscodeRequest } from '../src/lib/secureLoginProvisioning';
      const row = { key: 'da561bc4hash', displayName: 'MikeS24', companyId: 'co1', companyName: 'LG' };
      const r = buildSetPasscodeRequest(row, 'CorrectHorse7');
      console.log(JSON.stringify({ keys: Object.keys(r).sort(), temporary: r.temporary,
        leaksKey: JSON.stringify(r).includes(row.key) }));
    `, 'utf8');
    const r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
    }).trim().split('\n').pop());
    check('5. the built request carries temporary:false', r.temporary === false);
    check('3/4. the built request has no driverId/legacyHash',
      !r.keys.includes('driverId') && !r.keys.includes('legacyHash'), r.keys.join(','));
    check('6. a canonical companyId is preserved', r.keys.includes('companyId'));
    check('the legacy hash key never leaves the client', r.leaksKey === false);
  } catch (e) {
    check('request-shape probe ran', false, String(e.message).slice(0, 160));
  } finally {
    try { rmSync(probePath); } catch { /* best effort */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
