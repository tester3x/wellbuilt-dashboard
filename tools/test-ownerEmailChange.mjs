/**
 * vc51.9Z-3 — verify-before-update email change for the platform owner.
 *
 * WHY. Three verification sends to testerxxx@comcast.net were accepted by
 * Firebase and none arrived. The project uses Firebase's DEFAULT sender
 * (notification.sendEmail.method = DEFAULT, no template customization, no
 * custom domain — customDomainState NOT_STARTED), so mail leaves as
 * noreply@wellbuilt-sync.firebaseapp.com. That domain has SPF and DKIM but
 * publishes NO DMARC policy, and it is shared by every Firebase project.
 * Firebase exposes no delivery, bounce or suppression telemetry for it —
 * verified: zero identitytoolkit log entries and no audit configs.
 *
 * So there is no configuration defect to repair and no way to observe the
 * failure downstream. Moving the owner to a mailbox that demonstrably
 * receives mail is both the fix and the only experiment that separates
 * "this recipient" from "this project".
 *
 * WHAT THIS IS NOT. It does not weaken the gate: verifyBeforeUpdateEmail
 * sends to the NEW address and commits the change only after that link is
 * followed, so the mailbox is still proven. The UID never changes, so
 * roles, profile and every history binding are preserved.
 *
 * Run: node tools/test-ownerEmailChange.mjs
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

const probePath = join(ROOT, 'tools', '.ownerEmailChange.probe.mts');
let r = null;
try {
  writeFileSync(probePath, `
    import { mapEmailChangeError, validateNewEmail } from '../src/lib/emailChange';
    const out = {
      valid: validateNewEmail('mike@example.com', 'old@example.com'),
      sameAsCurrent: validateNewEmail('OLD@example.com', 'old@example.com'),
      empty: validateNewEmail('', 'old@example.com'),
      malformed: validateNewEmail('not-an-email', 'old@example.com'),
      errors: {
        inUse: mapEmailChangeError('auth/email-already-in-use'),
        recent: mapEmailChangeError('auth/requires-recent-login'),
        invalid: mapEmailChangeError('auth/invalid-email'),
        tooMany: mapEmailChangeError('auth/too-many-requests'),
        unknown: mapEmailChangeError('auth/whatever-new'),
      },
    };
    console.log(JSON.stringify(out));
  `, 'utf8');
  r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
  }).trim().split('\n').pop());
} catch (e) {
  check('emailChange module loads', false, String(e.message).slice(0, 200));
} finally {
  try { rmSync(probePath); } catch { /* best effort */ }
}

if (r) {
  check('a well-formed new address is accepted', r.valid.ok === true);
  check('the current address is refused', r.sameAsCurrent.ok === false,
    'case-insensitively — changing to the same mailbox fixes nothing');
  check('an empty address is refused', r.empty.ok === false);
  check('a malformed address is refused', r.malformed.ok === false);
  check('a collision is reported without naming the other account',
    /already/i.test(r.errors.inUse)
    && !/uid|owner|who|belongs to/i.test(r.errors.inUse), r.errors.inUse);
  check('recent-login is mapped to a re-authentication instruction',
    /sign in again|re-?authenticat/i.test(r.errors.recent), r.errors.recent);
  check('rate limiting is distinguishable', /wait|too many/i.test(r.errors.tooMany));
  check('an unmapped code still yields safe copy',
    typeof r.errors.unknown === 'string' && r.errors.unknown.length > 0);
  check('no message leaks a link, code or token',
    !Object.values(r.errors).some((m) => /oobCode|https?:\/\/|idToken|refreshToken/i.test(m)));
}

{
  const lib = strip(readFileSync(join(ROOT, 'src/lib/emailChange.ts'), 'utf8'));
  check('the canonical verify-before-update API is used',
    /verifyBeforeUpdateEmail\(/.test(lib),
    'updateEmail would change the address BEFORE the mailbox is proven');
  check('updateEmail is never called',
    !/\bupdateEmail\(/.test(lib));
  check('the change is applied to auth.currentUser only',
    /currentUser/.test(lib) && !/\buid\s*:/.test(lib));
  check('the continuation URL is the confirmed authorized origin',
    /https:\/\/wellbuilt-sync\.web\.app\/admin/.test(lib));
  check('nothing is logged and nothing is stored',
    !/console\.(log|warn|error|info|debug)/.test(lib)
    && !/localStorage|sessionStorage/.test(lib),
    'the proposed address must never be written beside a token');
}

{
  const card = strip(readFileSync(join(ROOT, 'src/components/admin/FirstAdminBootstrapCard.tsx'), 'utf8'));
  check('the card offers the address change only while unverified',
    /emailChangeOpen|Use a different email/i.test(card));
  check('the new address is typed by the authenticated operator',
    /type="email"/.test(card));
  check('the pending-change state is explained',
    /confirm|link/i.test(card));
  check('changing the address does not touch roles or driver identity',
    !/role|driverId|companyId/i.test(card));
  check('transient email-change state is cleared with the rest',
    /clearTransient/.test(card) && /setNewEmail\(''\)/.test(card));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
