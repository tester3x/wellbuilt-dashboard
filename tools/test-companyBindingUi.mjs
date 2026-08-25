/**
 * Phase C — the Company action routed through the governed binding path.
 *
 * The pre-existing action patched drivers/approved client-side for every
 * row. For a CANONICAL secure driver that could bind a profile with no
 * shift authority — the defect adminBindDriverCompany closes. This harness
 * proves the UI now routes canonical rows to the callable, keeps legacy
 * rows as clearly-labeled staging metadata, and refuses transfer/unbind
 * instead of silently rebinding.
 *
 * Run: node tools/test-companyBindingUi.mjs
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
const tab = strip(readFileSync(join(ROOT, 'src/components/admin/DriversTab.tsx'), 'utf8'));
const panel = strip(readFileSync(join(ROOT, 'src/components/admin/EmployeePanel.tsx'), 'utf8'));
const svc = strip(readFileSync(join(ROOT, 'src/lib/secureDriverAdmin.ts'), 'utf8'));

// ── the handler slice ────────────────────────────────────────────────────
const hs = tab.indexOf('const assignDriverCompany = async');
const he = tab.indexOf('const approveDriver', hs);
const handler = tab.slice(hs, he === -1 ? hs + 6000 : he);
check('handler slice is bounded', hs !== -1 && he > hs);

// route decision comes from the tested lib
check('the handler routes via the tested companyActionRouteFor',
  /const route = companyActionRouteFor\(companyTarget, assignCompanyId\);/.test(handler));

// canonical → callable, with exact payload
check('canonical rows invoke the governed callable',
  /adminBindCompany\(\{\s*driverId: \(companyTarget\.driverId \|\| ''\)\.trim\(\),\s*companyId: assignCompanyId\.trim\(\)\.toLowerCase\(\),\s*\}\)/.test(handler));
check('the payload carries ONLY driverId + companyId',
  !/companyName\s*:/.test(handler.slice(handler.indexOf('adminBindCompany({'),
    handler.indexOf('})', handler.indexOf('adminBindCompany({')))));
check('the service wrapper targets adminBindDriverCompany',
  /httpsCallable\(getFirebaseFunctions\(\), 'adminBindDriverCompany'\)/.test(svc));

// no canonical RTDB patch anywhere in the client
check('no client code writes drivers/profiles',
  !/drivers\/profiles/.test(tab) && !/drivers\/profiles/.test(panel) && !/drivers\/profiles/.test(svc));
{
  // The governed branch ends where the legacy staging updates object begins.
  const governed = handler.slice(handler.indexOf("route === 'governed_bind'"),
    handler.indexOf("companyId: assignCompanyId.trim().toLowerCase() || null"));
  check('the governed branch is bounded', governed.length > 100);
  check('the governed branch writes only the display mirror, never a binding source of truth',
    (governed.match(/update\(ref\(db,/g) || []).length === 1
    && /drivers\/approved\/\$\{companyTarget\.key\}/.test(governed));
  check('the mirror write happens only AFTER server success',
    governed.indexOf('await adminBindCompany') < governed.indexOf('update(ref(db,'));
  check('no unrelated employee action fires from the governed branch',
    !/onInvite|inviteEmployee|toggleDriverActive|handleRolePick|adminApproveSecure|adminRejectSecure|adminDeleteSecureDriver|adminSetPasscode/.test(governed));
}

// transfer / unbind refusals
check('a bound canonical driver cannot be silently rebound',
  /route === 'blocked_transfer'/.test(handler)
  && /separate transfer workflow/.test(handler));
check('canonical unbind is refused with explicit copy',
  /route === 'blocked_unbind'/.test(handler)
  && /cannot be removed from its company here/.test(handler));
check('blocked routes return before any write',
  handler.indexOf("route === 'blocked_unbind'") < handler.indexOf('adminBindCompany')
  && handler.indexOf("route === 'blocked_transfer'") < handler.indexOf('adminBindCompany'));

// pending / retry / error safety
check('double submission is suppressed while in flight',
  /if \(!companyTarget \|\| companyBusy\) return;/.test(handler));
check('the submit control is disabled while pending or ineligible',
  /companyAssignEnabled\(/.test(tab) && /companyBusy \? 'Assigning…'/.test(tab));
check('current company is labeled in the customer list',
  /\(current\)/.test(tab));
check('same-company click does not write',
  /route === 'noop_current'/.test(handler) && /Already assigned to this company/.test(handler)
  && handler.indexOf("route === 'noop_current'") < handler.indexOf('adminBindCompany'));
check('errors render sanitized copy, never the raw server error',
  !/setCompanyError\(\s*(String\()?err/.test(handler)
  && /Nothing was changed — you can retry|Nothing partial was kept — you can retry/.test(handler));
{
  // The ERROR catch (the one that sets companyError) must not close the
  // modal — the admin retries the same logical binding. The inner
  // display-mirror catch on the success path is separate and irrelevant.
  const cs = handler.indexOf('catch (err)', handler.indexOf('adminBindCompany'));
  const ce = handler.indexOf('finally', cs);
  const errCatch = handler.slice(cs, ce === -1 ? cs + 1500 : ce);
  check('an error keeps the modal open for a safe same-target retry',
    cs !== -1 && /setCompanyError\(/.test(errCatch)
    && !/setShowCompanyModal\(false\)/.test(errCatch)
    && !/setCompanyTarget\(null\)/.test(errCatch));
}
check('no complete sensitive identifier is rendered in messages',
  !/setMessage\([^)]*driverId/.test(handler) && !/setCompanyError\([^)]*driverId/.test(handler));

// accurate labeling in the modal
check('the modal states the legacy route is staging metadata',
  /staging metadata/i.test(tab));
check('the modal shows a bound canonical driver its current company',
  /Current company:/.test(tab));
check('the legacy staging message says when it applies',
  /applies when the secure login is created/.test(handler));

// ── route decision probe (tsx) ───────────────────────────────────────────
{
  const probePath = join(ROOT, 'tools', '.companyBindingUi.probe.mts');
  try {
    writeFileSync(probePath, `
      import { companyActionRouteFor, companyAssignEnabled } from '../src/lib/secureLoginProvisioning';
      const HASH = 'da561bc4hash';
      const legacy = { key: HASH, displayName: 'MikeS24' };
      const legacyBound = { key: HASH, displayName: 'Marcial Lebaron', companyId: 'liquid-gold' };
      const canonicalUnbound = { key: HASH, driverId: 'uuid-7f3a-9c21', displayName: 'MikeS24' };
      const canonicalBound = { key: HASH, driverId: 'uuid-7f3a-9c21', displayName: 'MikeS24', companyId: 'liquid-gold' };
      const hashEcho = { key: HASH, driverId: HASH, displayName: 'MikeS24' };
      const same = companyActionRouteFor(canonicalBound, 'liquid-gold');
      const legacyCurrent = companyActionRouteFor(legacyBound, 'liquid-gold');
      const legacyEmpty = companyActionRouteFor(legacyBound, '');
      const legacyOther = companyActionRouteFor(legacyBound, 'dakota-hauling');
      console.log(JSON.stringify({
        legacyAny: companyActionRouteFor(legacy, 'liquid-gold'),
        canonicalInitial: companyActionRouteFor(canonicalUnbound, 'liquid-gold'),
        canonicalSame: same,
        canonicalTransfer: companyActionRouteFor(canonicalBound, 'dakota-hauling'),
        canonicalUnbind: companyActionRouteFor(canonicalBound, ''),
        hashEcho: companyActionRouteFor(hashEcho, 'liquid-gold'),
        legacyCurrent, legacyEmpty, legacyOther,
        enableSame: companyAssignEnabled(same, { busy: false, authorized: true }),
        enableBusy: companyAssignEnabled(legacyOther, { busy: true, authorized: true }),
        enableUnauthorized: companyAssignEnabled(legacyOther, { busy: false, authorized: false }),
        enableOther: companyAssignEnabled(legacyOther, { busy: false, authorized: true }),
        enableEmpty: companyAssignEnabled(legacyEmpty, { busy: false, authorized: true }),
      }));
    `, 'utf8');
    const r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
    }).trim().split('\n').pop());
    check('legacy-only rows stay on the staging route', r.legacyAny === 'legacy_staging');
    check('canonical unbound routes to the governed bind', r.canonicalInitial === 'governed_bind');
    check('canonical same-target is a no-op (current company)', r.canonicalSame === 'noop_current');
    check('legacy already on that company is a no-op', r.legacyCurrent === 'noop_current');
    check('legacy empty selection is idle, not a remove write', r.legacyEmpty === 'noop_empty');
    check('legacy different company still stages', r.legacyOther === 'legacy_staging');
    check('Assign disabled for current company', r.enableSame === false);
    check('Assign disabled while in flight', r.enableBusy === false);
    check('Assign disabled when unauthorized', r.enableUnauthorized === false);
    check('Assign enabled only for a different eligible company', r.enableOther === true);
    check('Assign disabled when selection is empty', r.enableEmpty === false);
    check('canonical different-target is blocked as a transfer', r.canonicalTransfer === 'blocked_transfer');
    check('canonical removal is blocked as an unbind', r.canonicalUnbind === 'blocked_unbind');
    check('a hash echoed as driverId still routes as legacy staging', r.hashEcho === 'legacy_staging');
  } catch (e) {
    check('route decision probe ran', false, String(e.message).slice(0, 160));
  } finally {
    try { rmSync(probePath); } catch { /* best effort */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
