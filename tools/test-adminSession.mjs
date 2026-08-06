/**
 * vc51.9A7 — verified-admin session authorization matrix (Part 14).
 * Drives the pure machine in src/lib/adminUiLogic.ts with injected
 * claim sources and probes — no Firebase, no live calls.
 *
 * Run: node --experimental-strip-types tools/test-adminSession.mjs
 */
import {
  sessionAfterServiceError, sessionFromClaims, sessionMessage, verifyAdminSession,
} from '../src/lib/adminUiLogic.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const svcErr = (kind, adminCode = null) => ({ kind, adminCode });
const run = (deps, opts) => verifyAdminSession(deps, opts);
const okProbe = async () => {};
const denyProbe = (kind, adminCode) => async () => { throw svcErr(kind, adminCode); };

// Ordinary/claim-missing/verified basics.
check('signed-out user → signed_out', sessionFromClaims(false, null).status === 'signed_out');
check('ordinary user (no claim) sees no protected UI', sessionFromClaims(true, {}).status === 'ordinary');
check('viewAdmin-only claims still blocked (strict wellbuiltAdmin only)',
  sessionFromClaims(true, { viewAdmin: true, role: 'admin' }).status === 'ordinary');
check('truthy-string claim never verifies', sessionFromClaims(true, { wellbuiltAdmin: 'true' }).status === 'ordinary');
check('strict claim true → verified (display only)', sessionFromClaims(true, { wellbuiltAdmin: true }).status === 'verified');

// Full verification pass with probe.
{
  const s = await run({ signedIn: true, getClaims: async () => ({ wellbuiltAdmin: true }), probe: okProbe });
  check('claim + server probe OK → verified', s.status === 'verified');
}
{
  const s = await run({ signedIn: true, getClaims: async () => ({}), probe: okProbe });
  check('missing claim state (probe never needed)', s.status === 'ordinary');
}
{
  const s = await run({ signedIn: true, getClaims: async () => ({ wellbuiltAdmin: true }), probe: denyProbe('disabled_admin', 'admin_record_disabled') });
  check('claim present but record disabled → record_disabled', s.status === 'record_disabled');
}
{
  const s = await run({ signedIn: true, getClaims: async () => ({ wellbuiltAdmin: true }), probe: denyProbe('disabled_admin', 'unsupported_policy_version') });
  check('incompatible admin policy surfaces distinctly', s.status === 'incompatible_policy');
}
{
  const s = await run({ signedIn: true, getClaims: async () => ({ wellbuiltAdmin: true }), probe: denyProbe('missing_claim', 'missing_admin_claim') });
  check('server says claim missing (stale token) → ordinary with refresh path', s.status === 'ordinary');
}
{
  let forced = null;
  const s = await run({
    signedIn: true,
    getClaims: async (force) => { forced = force; return { wellbuiltAdmin: true }; },
    probe: okProbe,
  }, { forceRefresh: true });
  check('deliberate refresh forces token refresh exactly as requested', forced === true && s.status === 'verified');
}
{
  const s = await run({ signedIn: true, getClaims: async () => { throw new Error('network'); }, probe: okProbe }, { forceRefresh: true });
  check('failed refresh → refresh_failed (no loop, state bounded)', s.status === 'refresh_failed');
}
{
  const s = await run({ signedIn: false, getClaims: async () => null, probe: okProbe });
  check('signed-out verification short-circuits', s.status === 'signed_out');
}

// Service-error folding (server stays authoritative).
check('unauthenticated error folds to signed_out',
  sessionAfterServiceError({ status: 'verified' }, svcErr('unauthenticated')).status === 'signed_out');
check('validation error never demotes the session',
  sessionAfterServiceError({ status: 'verified' }, svcErr('validation', 'x')).status === 'verified');
check('disabled_admin error demotes verified display',
  sessionAfterServiceError({ status: 'verified' }, svcErr('disabled_admin', 'no_admin_record')).status === 'record_disabled');

// Honest bounded messages (no silent fallback).
for (const [status, mustMention] of [
  ['ordinary', 'refresh administrator access'],
  ['record_disabled', 'another enabled platform administrator'],
  ['incompatible_policy', 'newer admin policy'],
  ['refresh_failed', 'refresh failed'],
]) {
  const m = sessionMessage({ status });
  check(`message for ${status} is honest and bounded`,
    (m.title + ' ' + m.body).toLowerCase().includes(mustMention.toLowerCase()));
}
check('ordinary message says viewAdmin does not unlock',
  sessionMessage({ status: 'ordinary' }).body.includes('viewAdmin'));
check('refresh offered only where it can help',
  sessionMessage({ status: 'ordinary' }).showRefresh === true
  && sessionMessage({ status: 'record_disabled' }).showRefresh === false
  && sessionMessage({ status: 'incompatible_policy' }).showRefresh === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
