/**
 * vc51.9Z-4 — the audit tab must not claim "no records" when it failed.
 *
 * LIVE FAILURE. Admin Audit showed BOTH
 *   "The service is temporarily unavailable. It is safe to retry."
 * and
 *   "No audit records yet."
 * while platform_admin_audit actually held one record — the bootstrap
 * grant itself.
 *
 * Cause: `entries` starts as [] and is only replaced on success, so the
 * render falls through to the empty-state copy on every failure. In an
 * AUDIT surface that is not a cosmetic wording issue: the screen asserts
 * that no privileged action has ever been recorded, which is exactly the
 * claim an operator would rely on when checking whether something
 * happened. Absence of evidence gets rendered as evidence of absence.
 *
 * (The underlying 404 — adminListAdminAudit was never deployed — is a
 * deployment gap, fixed separately. This is the reporting defect that
 * made the gap look like a clean empty state.)
 *
 * Run: node tools/test-adminAuditTabLoadState.mjs
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

const raw = readFileSync(join(ROOT, 'src/components/admin/AdminAuditTab.tsx'), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── THE defect ───────────────────────────────────────────────────────────
// Every occurrence of the empty-state claim must be guarded by a
// SUCCESSFUL load. Checking the guard that precedes it, not just the
// shape of the ternary — the old assertion still matched once a guard
// was added in front of the same `entries.length === 0 ?`.
{
  const CLAIM = 'No audit records yet';
  let i = code.indexOf(CLAIM), n = 0, unguarded = 0;
  while (i !== -1) {
    n++;
    if (!/loadPhase === 'ready'/.test(code.slice(Math.max(0, i - 120), i))) unguarded++;
    i = code.indexOf(CLAIM, i + 1);
  }
  check('1. the empty-state claim appears and is always guarded by a successful load',
    n > 0 && unguarded === 0,
    `${n} occurrence(s), ${unguarded} not guarded by loadPhase === 'ready'`);
}

check('2. an explicit load phase distinguishes failure from empty',
  /loadPhase|'loading'\s*\|\s*'ready'\s*\|\s*'error'/.test(code));

check('3. the empty-state copy is reachable only after a successful load',
  /loadPhase === 'ready'[\s\S]{0,200}No audit records yet/.test(code)
  || /loadPhase !== 'error'[\s\S]{0,200}No audit records yet/.test(code),
  'it must be gated on the read having actually succeeded');

// ── the failure must stay visible and recoverable ────────────────────────
check('4. a failed load renders an error state', /loadPhase === 'error'/.test(code));
check('4. the operator can retry without a page reload',
  /Retry/.test(code) && /onClick=\{[^}]*load/.test(code));
check('4. the mapped guidance is still shown', /notice/.test(code));

// ── the read stays read-only and unprivileged client-side ────────────────
check('5. the tab reads only through the callable service',
  /service\.listAdminAudit\(/.test(code)
  && !/firebase\/firestore|collection\(|getDocs\(/.test(code),
  'no direct Firestore access from an audit surface');

// ── nothing sensitive is rendered ────────────────────────────────────────
check('6. no token or credential material is rendered',
  !/idToken|accessToken|Bearer|password|passcode/i.test(code));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
