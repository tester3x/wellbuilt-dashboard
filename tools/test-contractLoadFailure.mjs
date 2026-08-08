/**
 * vc51.9Y — the contract panel must name the actual failure.
 *
 * LIVE FAILURE: Admin -> Companies -> Liquid Gold Trucking LLC rendered
 * "Could not load contract state." with a Retry button. Retrying never
 * changed anything, and the message named no cause.
 *
 * Root cause: the panel's catch mapped on `(err as {code?: string}).code`.
 * The typed service NEVER throws an object with `code` — every callable
 * rejection goes through normalizeAdminError() and arrives as an
 * AdminServiceError carrying `kind` + `adminCode`. So `code` was always
 * undefined, every branch of the ternary missed, and ALL causes —
 * missing claim, disabled admin record, expired session, absent company —
 * collapsed into the same generic sentence. The accurate message was in
 * fact already being computed by surface() -> errorGuidance(), and then
 * discarded, because the error branch returns early rendering only
 * loadError.
 *
 * The server's real answer here is permission-denied/missing_admin_claim:
 * authorizeAdminCall requires BOTH the wellbuiltAdmin custom claim and an
 * enabled platform_admins/{uid} record, and neither is implied by the
 * Dashboard's "Owner" profile role. That is precisely the distinction the
 * generic string erased.
 *
 * Behavioural, not structural: the mapping is exercised through the real
 * normalizeAdminError + errorGuidance.
 *
 * Run: node tools/test-contractLoadFailure.mjs
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

const GENERIC = 'Could not load contract state.';

// ── behaviour ────────────────────────────────────────────────────────────
const probePath = join(ROOT, 'tools', '.contractLoadFailure.probe.mts');
let r = null;
try {
  writeFileSync(probePath, `
    import { contractLoadFailure } from '../src/lib/adminLoadFailure';
    import { AdminServiceError } from '../src/lib/adminContractServiceCore';

    const cases: Record<string, unknown> = {
      // what the live panel actually received
      missing_claim: new AdminServiceError('missing_claim', 'missing_admin_claim'),
      disabled_admin: new AdminServiceError('disabled_admin', 'no_admin_record'),
      unauthenticated: new AdminServiceError('unauthenticated', null),
      not_found: new AdminServiceError('not_found', 'company_not_found'),
      validation: new AdminServiceError('validation', 'unknown_fields:foo'),
      retryable: new AdminServiceError('retryable', 'unavailable'),
      unknown: new AdminServiceError('unknown', 'weird'),
      // an un-normalized firebase/functions rejection must map too
      rawHttps: Object.assign(new Error('permission denied'), {
        code: 'functions/permission-denied',
        details: { adminCode: 'missing_admin_claim' },
      }),
      // something that is not an error at all must not throw
      junk: 'not an error',
    };

    const out: Record<string, { message: string; action: string; retryable: boolean }> = {};
    for (const [k, v] of Object.entries(cases)) {
      const g = contractLoadFailure(v);
      out[k] = { message: g.message, action: g.action, retryable: g.retryable };
    }
    console.log(JSON.stringify(out));
  `, 'utf8');
  r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
  }).trim().split('\n').pop());
} catch (e) {
  check('contractLoadFailure probe ran', false, String(e.message).slice(0, 200));
} finally {
  try { rmSync(probePath); } catch { /* best effort */ }
}

if (r) {
  // 1. THE defect: distinct causes must not share one message.
  const msgs = Object.entries(r).map(([k, v]) => [k, v.message]);
  const distinct = new Set(msgs.map(([, m]) => m));
  check('1. distinct failure causes produce distinct messages',
    distinct.size >= 7, `${distinct.size} distinct message(s) across ${msgs.length} causes`);

  // 2. No real cause may fall through to the generic sentence.
  for (const [k, v] of msgs) {
    if (k === 'junk') continue;
    check(`2. ${k} is not reported as the generic string`, v !== GENERIC, v);
  }

  // 3. The live cause must be actionable and must point at the session,
  //    not at the company or the network.
  check('3. missing_claim names administrator access',
    /administrator access/i.test(r.missing_claim.message));
  check('3. missing_claim tells the operator to refresh access',
    r.missing_claim.action === 'refresh-access');
  check('3. missing_claim is not presented as retryable',
    r.missing_claim.retryable === false,
    'retrying an unauthorized read can never succeed');

  // 4. A disabled server record must be distinguishable from a missing
  //    claim — the two demand completely different remedies.
  check('4. disabled_admin differs from missing_claim',
    r.disabled_admin.message !== r.missing_claim.message);
  check('4. disabled_admin directs the operator to another admin',
    r.disabled_admin.action === 'contact-admin');

  // 5. An absent company must read as an absent company.
  check('5. not_found is reported as a missing target',
    /no longer exists/i.test(r.not_found.message));

  // 6. Only a genuinely transient failure is retryable.
  check('6. retryable is the only retryable cause',
    r.retryable.retryable === true
    && ['missing_claim', 'disabled_admin', 'unauthenticated', 'not_found', 'validation']
      .every((k) => r[k].retryable === false));

  // 7. An un-normalized callable rejection maps identically.
  check('7. a raw functions/permission-denied maps like the normalized form',
    r.rawHttps.message === r.missing_claim.message,
    `${r.rawHttps.message} vs ${r.missing_claim.message}`);

  // 8. Non-errors degrade safely instead of throwing.
  check('8. a non-error input still yields guidance',
    typeof r.junk.message === 'string' && r.junk.message.length > 0);

  // 9. Nothing sensitive is echoed.
  check('9. no token or credential material appears in any message',
    !Object.values(r).some((v) => /idToken|accessToken|Bearer|password|passcode/i.test(v.message)));
}

// ── the panel must use it ────────────────────────────────────────────────
{
  const raw = readFileSync(join(ROOT, 'src/components/admin/CompanyContractPanel.tsx'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('10. the panel no longer maps on a `code` property',
    !/\(err as \{ code\?: string \}\)/.test(code) && !/\.code \|\| ''/.test(code),
    'AdminServiceError never carries `code`');
  check('10. the panel derives its load failure from the shared mapper',
    /contractLoadFailure\(/.test(code));
  check('10. the hand-rolled load-error ternary is gone',
    !new RegExp(`'${GENERIC.replace('.', '\\.')}'`).test(code)
    || !/unauthenticated\|permission-denied/.test(code),
    'the unreachable regex ternary must not remain');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
