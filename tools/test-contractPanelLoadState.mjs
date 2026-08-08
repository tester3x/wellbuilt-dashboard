/**
 * vc51.9X — the contract panel must never spin forever.
 *
 * LIVE FAILURE: Admin -> Companies -> Liquid Gold Trucking LLC sat on
 * "Loading contract state…" indefinitely.
 *
 * The panel used `state === null` as its loading sentinel, and `state` is
 * assigned only on reload()'s success path. A rejected
 * getCompanyContractConfiguration hit catch -> surface(err), which sets a
 * notice — but the early return at the top fires BEFORE the notice can
 * render, so the operator sees a permanent spinner and never learns what
 * failed. The three read-only callables were confirmed deployed and
 * returning 401 to unauthenticated probes, so the fault is entirely in the
 * client's load-state handling.
 *
 * Loading, loaded, and failed must be distinct, and a failure must be
 * recoverable without a page reload.
 *
 * Run: node tools/test-contractPanelLoadState.mjs
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

const raw = readFileSync(join(ROOT, 'src/components/admin/CompanyContractPanel.tsx'), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── the exact defect ─────────────────────────────────────────────────────
check('the loading gate is not keyed on the data being null',
  !/if \(state === null\) return <p[^>]*>Loading contract state/.test(code),
  'a failed load leaves state null forever, so the spinner never clears');

check('an explicit load phase exists',
  /loadPhase|'loading'\s*\|\s*'ready'\s*\|\s*'error'/.test(code),
  'loading / ready / error must be distinguishable');

// ── a failure must be visible and recoverable ────────────────────────────
check('a failed load renders an error state',
  /loadPhase === 'error'/.test(code));
check('the failed state offers a Retry action',
  /Retry/.test(code) && /onClick=\{[^}]*reload/.test(code),
  'the operator must recover without reloading the page');
check('the failure message is shown to the operator',
  /loadError/.test(code));

// ── the load path stays read-only ────────────────────────────────────────
{
  const s = code.indexOf('const reload');
  const e = code.indexOf('const run =', s);
  const body = code.slice(s, e === -1 ? s + 1500 : e);
  check('reload calls only read-only services',
    /getCompanyContractConfiguration|previewCompanyEffectiveCapabilities/.test(body)
    && !/setCompanyContractEnforcement|setCompanyWorkPeriodConfiguration|assignCompanyPlan|updateCompanySafe|addEntitlementOverride|removeEntitlementOverride/.test(body),
    'the load path must never mutate configuration');
}

// ── one missing callable must not blank the whole panel ──────────────────
// `.then((r) => setPlans(r.plans))` contains nested parens, so a
// [^)]*-style match cannot span it.
check('the plans list failing does not block contract state',
  /listPlans\([\s\S]{0,60}?\)\s*\.then\([\s\S]{0,80}?\)\s*\.catch\(/.test(code),
  'listPlans must be caught independently of reload()');
check('a preview failure does not discard the contract state already read',
  /catch \(previewErr\)/.test(code));

// ── no secret or token surfaces ──────────────────────────────────────────
check('no token or credential material is rendered or logged',
  !/idToken|accessToken|Bearer|password|passcode/i.test(code));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
