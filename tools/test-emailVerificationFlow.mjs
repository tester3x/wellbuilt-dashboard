/**
 * vc51.9Z-2 — email verification for the platform-admin bootstrap.
 *
 * The bootstrap callable refused Mike with `email_unverified`. That
 * precondition is mandatory and stays exactly as it is: this adds the
 * normal, authenticated Firebase verification flow so he can satisfy it
 * himself, with no service-account key, no administrative mutation of the
 * Firebase user, and no weakening of the server gate.
 *
 * The whole flow is scoped to `auth.currentUser`. There is no email input
 * and no uid input anywhere in it — a verification mail can only ever be
 * sent to the address the session already proves control of, so there is
 * nothing to point at a third party and nothing that could reveal whether
 * some unrelated address exists.
 *
 * Run: node tools/test-emailVerificationFlow.mjs
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

// ── behaviour of the pure decision layer ─────────────────────────────────
const probePath = join(ROOT, 'tools', '.emailVerification.probe.mts');
let r = null;
try {
  writeFileSync(probePath, `
    import {
      RESEND_COOLDOWN_MS, canSendVerification, cooldownRemainingMs,
      mapVerificationError, verificationCopy,
    } from '../src/lib/emailVerification';

    const base = { signedIn: true, emailVerified: false, sending: false, lastSentAt: null as number | null, now: 1_000_000 };
    const out = {
      cooldownMs: RESEND_COOLDOWN_MS,
      freshSend: canSendVerification(base),
      whileSending: canSendVerification({ ...base, sending: true }),
      duringCooldown: canSendVerification({ ...base, lastSentAt: 1_000_000 - 5_000 }),
      afterCooldown: canSendVerification({ ...base, lastSentAt: 1_000_000 - (RESEND_COOLDOWN_MS + 1) }),
      whenVerified: canSendVerification({ ...base, emailVerified: true }),
      whenSignedOut: canSendVerification({ ...base, signedIn: false }),
      remainingMid: cooldownRemainingMs(1_000_000 - 20_000, 1_000_000),
      remainingNever: cooldownRemainingMs(null, 1_000_000),
      remainingPast: cooldownRemainingMs(1_000_000 - 999_999, 1_000_000),
      errors: {
        tooMany: mapVerificationError('auth/too-many-requests'),
        network: mapVerificationError('auth/network-request-failed'),
        expired: mapVerificationError('auth/user-token-expired'),
        unknown: mapVerificationError('auth/some-new-thing'),
        empty: mapVerificationError(''),
      },
      sentCopy: verificationCopy.sent,
    };
    console.log(JSON.stringify(out));
  `, 'utf8');
  r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
  }).trim().split('\n').pop());
} catch (e) {
  check('emailVerification module loads', false, String(e.message).slice(0, 200));
} finally {
  try { rmSync(probePath); } catch { /* best effort */ }
}

if (r) {
  // 1/2. who sees the action
  check('1. an unverified signed-in user may send', r.freshSend === true);
  check('2. a verified user may NOT send', r.whenVerified === false,
    'the action must disappear once the mailbox is proven');
  check('a signed-out user may not send', r.whenSignedOut === false);

  // 5. cooldown
  check('5. a send in flight blocks another', r.whileSending === false);
  check('5. the cooldown blocks a repeat send', r.duringCooldown === false);
  check('5. the cooldown expires', r.afterCooldown === true);
  check('5. the cooldown is a real interval', r.cooldownMs >= 30_000, `${r.cooldownMs}ms`);
  check('5. remaining time counts down and floors at zero',
    r.remainingMid > 0 && r.remainingMid <= r.cooldownMs
    && r.remainingNever === 0 && r.remainingPast === 0);

  // 6/7. copy and error mapping
  check('6. the success copy is safe and non-committal about delivery',
    typeof r.sentCopy === 'string' && r.sentCopy.length > 0
    && !/does not exist|no account|invalid address/i.test(r.sentCopy));
  check('7. a rate-limit error maps to safe guidance',
    /wait|too many/i.test(r.errors.tooMany) && r.errors.tooMany !== r.errors.unknown);
  check('7. a network error is distinguishable', /connection|network/i.test(r.errors.network));
  check('7. an expired session maps to sign-in guidance', /sign in/i.test(r.errors.expired));
  check('7. an unmapped code still yields safe copy',
    typeof r.errors.unknown === 'string' && r.errors.unknown.length > 0
    && typeof r.errors.empty === 'string');
  check('7. no error message reveals whether another address exists',
    !Object.values(r.errors).some((m) => /exist|registered|already in use|not found/i.test(m)),
    JSON.stringify(r.errors));
  check('12. no message carries a code, link or token',
    !Object.values(r.errors).concat(r.sentCopy)
      .some((m) => /oobCode|actionLink|https?:\/\/|idToken|refreshToken/i.test(m)));
}

// ── the client wiring ────────────────────────────────────────────────────
{
  const lib = strip(readFileSync(join(ROOT, 'src/lib/emailVerification.ts'), 'utf8'));

  // 3/4. scope: current user only
  check('4. the send targets auth.currentUser and nothing else',
    /sendEmailVerification\(\s*user\b/.test(lib) && /currentUser/.test(lib));
  check('3. the send function accepts no email or uid argument',
    /export async function sendVerificationToCurrentUser\(\s*\)/.test(lib),
    'an argument would be a way to target another address');
  check('4. the continuation URL is the confirmed authorized Dashboard origin',
    /https:\/\/wellbuilt-sync\.web\.app\/admin/.test(lib),
    'verified present in Firebase Auth authorizedDomains');
  check('4. the continuation URL carries no secret query data',
    !/[?&](token|idToken|refreshToken|password|claim|oobCode|secret)=/i.test(lib));

  // 8/9. refresh
  check('8. refresh reloads the Firebase user', /\breload\(\s*\)/.test(lib));
  check('9. refresh forces a NEW id token', /getIdToken\(true\)/.test(lib));
  check('8/9. refresh reports the reloaded verification state',
    /emailVerified/.test(lib));

  // 12. secrets
  check('12. nothing is logged',
    !/console\.(log|warn|error|info|debug)/.test(lib));
  check('12. no token or code is stored',
    !/localStorage|sessionStorage/.test(lib));
}

{
  const card = strip(readFileSync(join(ROOT, 'src/components/admin/FirstAdminBootstrapCard.tsx'), 'utf8'));

  // 1/2. the two states of the card
  check('1. an unverified user is shown the Send action',
    /Send verification email/.test(card));
  check('1. the signed-in address is shown',
    /\{email \?\?|\{email\}/.test(card),
    'the operator must see which mailbox will receive the link');
  check('1. the reason verification is required is explained',
    /proving control of the mailbox/i.test(card));
  check('2. the Send action is gated on the unverified state',
    /!\s*emailVerified|emailVerified === false/.test(card));

  // 3. no arbitrary input
  check('3. the card has no email or uid input field',
    !/<input/.test(card) || !/type="email"/.test(card),
    'there must be nothing to type an address into');

  // 10/11. activation stays explicit
  check('10. activation is offered once the address is verified',
    /Activate platform administration/.test(card));
  check('11. verifying does NOT auto-invoke bootstrap',
    !/emailVerified[\s\S]{0,120}runFirstAdminBootstrap/.test(card),
    'the activation click must remain deliberate');
  check('11. bootstrap runs only from its own click handler',
    /onClick=\{\(\) => \{ void run\(\); \}\}/.test(card));

  // refresh action
  check('8. the card offers an explicit refresh-status action',
    /I verified my email/.test(card));

  // cooldown surfaced
  check('5. the cooldown is reflected in the control',
    /canSendVerification|cooldown/i.test(card));

  // 12. transient state hygiene
  check('12. transient state is cleared on unmount/sign-out',
    /useEffect\([\s\S]{0,300}return \(\) =>/.test(card) || /clearTransient/.test(card));
  check('12. no secret VALUE is rendered or interpolated',
    !/oobCode|actionLink|{[^}]*(idToken|refreshToken|password)/i.test(card),
    'reassurance copy mentioning a password is fine; a password VALUE is not');
  check('12. no console logging in the card',
    !/console\.(log|warn|error|info|debug)/.test(card));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
