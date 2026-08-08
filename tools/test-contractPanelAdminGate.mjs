/**
 * vc51.9Y — the contract panel must be gated by the SAME authority the
 * server enforces.
 *
 * THE LIVE FAILURE. Mike opened Admin -> Companies -> Liquid Gold Trucking
 * LLC signed in as an account the Dashboard shows as "Owner", and every
 * contract read was denied.
 *
 * CompaniesTab renders the panel on isPlatformAdmin(user) — a Firestore
 * PROFILE role (no companyId, role it/admin). The callable enforces
 * something else entirely (functions/src/admin/authority.ts):
 *
 *   1. the Firebase Auth custom claim wellbuiltAdmin === true, AND
 *   2. an exact ENABLED platform_admins/{uid} Firestore record.
 *
 * A company role — Owner included — implies neither. So the client offered
 * an administration tool its own session could never use, and the operator
 * had no way to learn why. The two gates are not interchangeable and the
 * client must stop pretending they are.
 *
 * The Dashboard already models this correctly: useVerifiedAdmin reads the
 * claim and makes ONE bounded probe so "claim present but record disabled"
 * is honest at entry, and VerifiedAdminGate renders the reason plus a
 * "Refresh administrator access" action. admin/page.tsx uses both. The
 * Companies tab simply did not.
 *
 * This does NOT weaken or replace the profile-role gate — isPlatformAdmin
 * still decides who is offered the area. It adds the second gate the
 * server actually applies, so the surface matches the contract.
 *
 * Run: node tools/test-contractPanelAdminGate.mjs
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
const panel = strip(readFileSync(join(ROOT, 'src/components/admin/CompanyContractPanel.tsx'), 'utf8'));
const tab = strip(readFileSync(join(ROOT, 'src/components/admin/CompaniesTab.tsx'), 'utf8'));

// ── 1. the panel consults the verified-admin session ─────────────────────
check('1. the panel verifies administrator access',
  /useVerifiedAdmin\(\)/.test(panel),
  'the profile role alone does not satisfy the server');
check('1. an unverified session renders the reason, not the tool',
  /VerifiedAdminGate/.test(panel));
check('1. the operator is offered the refresh action',
  /onRefresh=\{refreshAccess\}/.test(panel));

// ── 2. the existing profile-role gate is PRESERVED ───────────────────────
// The product rule is unchanged: the Owner account still administers
// companies. This adds the server's gate; it does not swap one for the
// other, and it must not demand a second account or a lesser role.
check('2. CompaniesTab still gates the panel on isWbAdmin',
  /\{isWbAdmin && <CompanyContractPanel/.test(tab),
  'the profile-role gate must not be removed');
check('2. no role is downgraded and no alternate account is required',
  !/(second account|use an admin account|sign in as)/i.test(panel));

// ── 3. the gate decides BEFORE the load phase is rendered ────────────────
// An unverified operator must see the reason — not a spinner, and not a
// denial dressed up as a failed read.
{
  const gate = panel.indexOf("session.status !== 'verified'");
  const errBranch = panel.indexOf("loadPhase === 'error'");
  const loadBranch = panel.indexOf("loadPhase === 'loading'");
  check('3. the gate is evaluated before the error branch',
    gate > 0 && errBranch > 0 && gate < errBranch, `gate@${gate} error@${errBranch}`);
  check('3. the gate is evaluated before the loading branch',
    gate > 0 && loadBranch > 0 && gate < loadBranch, `gate@${gate} loading@${loadBranch}`);
}

// ── 3b. no guaranteed-denied read is issued ──────────────────────────────
check('3b. the load is not attempted while the session is unverified',
  /if \(session\.status !== 'verified'\) return;/.test(panel),
  'every row would otherwise fire a callable read that can only be denied');

// ── 4. the server remains authoritative ──────────────────────────────────
check('4. the client gate is display-only — no local authority substitute',
  !/localStorage\.getItem\(['"](role|admin|wellbuiltAdmin)/.test(panel)
  && !/claims\.wellbuiltAdmin\s*=/.test(panel));
check('4. the panel still calls the protected callables',
  /getCompanyContractConfiguration|previewCompanyEffectiveCapabilities/.test(panel));

// ── 5. the two authorities are genuinely different ───────────────────────
// Proven against the real predicate, not asserted: a caller with the
// profile role but no claim must be refused by the server's own decision
// function, and the enabled record alone must not be enough either.
const probePath = join(ROOT, 'tools', '.adminGate.probe.mjs');
let r = null;
try {
  writeFileSync(probePath, `
    import { authorizeAdminCall } from '../functions/lib/admin/authority.js';
    const record = { enabled: true, policyVersion: 1 };
    const out = {
      // signed in, company "Owner" profile, no custom claim
      ownerNoClaim: authorizeAdminCall(
        { uid: 'u1', token: { email: 'o@x.com', role: 'owner', admin: true } }, record),
      // claim present, no server record — gate 2
      claimNoRecord: authorizeAdminCall(
        { uid: 'u1', token: { email: 'o@x.com', wellbuiltAdmin: true } }, null),
      // both gates
      both: authorizeAdminCall(
        { uid: 'u1', token: { email: 'o@x.com', wellbuiltAdmin: true } }, record),
      // truthy-but-not-true must not pass
      truthyClaim: authorizeAdminCall(
        { uid: 'u1', token: { email: 'o@x.com', wellbuiltAdmin: 'yes' } }, record),
    };
    console.log(JSON.stringify(out));
  `, 'utf8');
  r = JSON.parse(execFileSync('node', [probePath], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim().split('\n').pop());
} catch (e) {
  check('authority probe ran (functions must be built)', false, String(e.message).slice(0, 200));
} finally {
  try { rmSync(probePath); } catch { /* best effort */ }
}

if (r) {
  check('5. a company Owner profile without the claim is REFUSED by the server',
    r.ownerNoClaim.ok === false && r.ownerNoClaim.reason === 'missing_admin_claim',
    JSON.stringify(r.ownerNoClaim));
  check('5. the claim alone is refused without the record',
    r.claimNoRecord.ok === false && r.claimNoRecord.reason === 'no_admin_record',
    JSON.stringify(r.claimNoRecord));
  check('5. both gates together are accepted',
    r.both.ok === true, JSON.stringify(r.both));
  check('5. a truthy non-true claim never passes',
    r.truthyClaim.ok === false && r.truthyClaim.reason === 'claim_not_true');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
