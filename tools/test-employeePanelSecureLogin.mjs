/**
 * Phase A — Secure WellBuilt login surfaced in the PRIMARY Employee panel.
 *
 * The governed Create-secure-login flow previously existed only behind the
 * "Show legacy view" link; the default unified Employees panel could not
 * reach it. This harness proves the primary panel now exposes the action —
 * and that it does so by ROUTING to the parent's single resolver, modal and
 * request builder rather than growing a second provisioning implementation.
 *
 * Behavioural coverage of the request itself (no driverId, no legacyHash,
 * company binding carried, temporary:false) lives in
 * test-secureLoginProvisioning.mjs; modal secret-lifetime coverage lives in
 * test-createSecureLoginUi.mjs. This file covers the panel wiring.
 *
 * Run: node tools/test-employeePanelSecureLogin.mjs
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

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const panel = strip(readFileSync(join(ROOT, 'src/components/admin/EmployeePanel.tsx'), 'utf8'));
const tab = strip(readFileSync(join(ROOT, 'src/components/admin/DriversTab.tsx'), 'utf8'));

// ── the action exists in the PRIMARY panel ───────────────────────────────
check('the primary panel renders a "Create secure login" action',
  /Create secure login/.test(panel));
check('the block is labeled as the secure WellBuilt login, distinct from WB-T',
  /Secure WellBuilt login/.test(panel) && /WB-T Mobile Login/.test(panel));
check('already-secure rows show an Active status instead of the create action',
  /secureLoginStateFor\(row\) === 'secured'[\s\S]{0,300}Active/.test(panel));

// ── single provisioning implementation ───────────────────────────────────
check('the panel holds NO provisioning logic of its own',
  !/adminSetPasscode|buildSetPasscodeRequest|httpsCallable|adminSetDriverPasscode/.test(panel));
check('the panel holds no secret state (no password fields)',
  !/type="password"/.test(panel) && !/securePass|secureConfirm/.test(panel),
  'the word "passcode" may appear in copy; secret inputs/state may not');
check('the panel routes creation to the parent callback only',
  /onCreateSecureLogin\?\.\(row\)/.test(panel));
check('eligibility comes from the parent resolver, not local rules',
  /secureLoginStateFor\?:/.test(panel)
  && !/credentialActionFor|hasCanonicalDriverId/.test(panel));

// ── both views share one resolver and one modal ──────────────────────────
check('the parent passes its shared resolver to the panel',
  /secureLoginStateFor=\{\(row\) => \(row\.driver \? secureLoginStateFor\(row\.driver\) : 'none'\)\}/.test(tab));
check('the legacy view asks the SAME resolver',
  /secureLoginStateFor\(driver\) === 'create'/.test(tab));
check('exactly one Create-secure-login modal exists',
  (tab.match(/\{secureTarget && \(/g) || []).length === 1);
check('exactly one submit handler exists',
  (tab.match(/handleCreateSecureLogin/g) || []).length >= 2
  && (tab.match(/const handleCreateSecureLogin/g) || []).length === 1);

// ── selected-employee identity ───────────────────────────────────────────
{
  const s = tab.indexOf('onCreateSecureLogin={(row)');
  const e = tab.indexOf('}}', s);
  const cb = tab.slice(s, e === -1 ? s + 400 : e);
  check('the panel callback is bounded for inspection', s !== -1 && e > s);
  check('the callback targets the SELECTED row\'s driver record',
    /setSecureTarget\(row\.driver\)/.test(cb));
  check('the callback re-checks eligibility before opening the modal',
    /secureLoginStateFor\(row\.driver\) === 'create'/.test(cb));
  check('no unrelated employee action can fire from the callback',
    !/onInvite|toggleDriverActive|inviteEmployee|handleRolePick|saveEmployeeRoles|adminApproveSecure|adminRejectSecure|adminDeleteSecureDriver|setShowCompanyModal|setShowRoutesModal/.test(cb));
}

// ── the panel's secure block fires nothing else ──────────────────────────
{
  const s = panel.indexOf('Secure WellBuilt login:');
  const e = panel.indexOf('</div>', panel.indexOf('Create secure login', s));
  const block = panel.slice(s, e === -1 ? s + 1200 : e);
  check('the secure block is bounded for inspection', s !== -1);
  check('the secure block invokes ONLY onCreateSecureLogin',
    /onCreateSecureLogin/.test(block)
    && !/onToggleMobile|onInvite|onSaveRoles|onAssignRoutes|onAssignCompany/.test(block));
}

// ── masked success: no complete UUID, no passcode ────────────────────────
check('success copy no longer renders the canonical UUID',
  !/New driver ID|res\.driverId|res\?\.driverId/.test(tab));
check('success copy names the employee',
  /setSecureDone\(`Secure login created for \$\{secureTarget\.displayName\}\.`\)/.test(tab));
check('success records the row as secured for this session',
  /setSecuredKeys\(prev => new Set\(prev\)\.add\(secureTarget\.key\)\)/.test(tab));

// ── canonical-id mapping feeds the decision layer, safely ────────────────
check('loadDrivers maps a server-stamped canonical id (string-typed only)',
  /typeof val\.migratedToDriverId === 'string'/.test(tab));
check('the resolver hides the action for inactive rows',
  /driver\.active !== false \? 'create' : 'none'/.test(tab));

// ── decision-layer probe: secured vs legacy-only states ──────────────────
{
  const probePath = join(ROOT, 'tools', '.employeePanelSecureLogin.probe.mts');
  try {
    writeFileSync(probePath, `
      import { credentialActionFor } from '../src/lib/secureLoginProvisioning';
      const legacyOnly = { key: 'da561bc4hash', displayName: 'MikeS24' };
      const migrated = { key: 'da561bc4hash', displayName: 'MikeS24', driverId: 'uuid-7f3a-9c21' };
      const hashEcho = { key: 'da561bc4hash', displayName: 'MikeS24', driverId: 'da561bc4hash' };
      console.log(JSON.stringify({
        legacyOnly: credentialActionFor(legacyOnly),
        migrated: credentialActionFor(migrated),
        hashEcho: credentialActionFor(hashEcho),
      }));
    `, 'utf8');
    const r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
    }).trim().split('\n').pop());
    check('a legacy-only row resolves to the create action',
      r.legacyOnly === 'create_secure_login');
    check('a migrated row (canonical id) resolves to secured semantics',
      r.migrated === 'reset_passcode');
    check('a hash echoed as driverId can NEVER read as secured',
      r.hashEcho === 'create_secure_login');
  } catch (e) {
    check('decision-layer probe ran', false, String(e.message).slice(0, 160));
  } finally {
    try { rmSync(probePath); } catch { /* best effort */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
