/**
 * vc51.9U — the Create-secure-login / Reset-passcode boundary.
 *
 * WHY THIS IS SHARP
 * A legacy driver row's RTDB key IS the passcode hash, and WB-S's legacy
 * login persisted `driverId: hash` — so every shift, ticket, JSA record and
 * DVIR receipt is keyed by credential-derived material. Two mistakes are
 * possible and both are bad:
 *
 *   passing that key as `driverId`  -> permanently enshrines the credential
 *                                      as identity
 *   minting a fresh id for a driver -> orphans live records
 *   who already has a canonical one
 *
 * And the callable's `legacyHash` branch writes
 * `migratedFromLegacyHashPrefix` — eight characters of the legacy hash —
 * into the new profile beside the display name. That is the same
 * credential-derived material just removed from the logs, made durable, so
 * the create path must not take that branch.
 *
 * Run: node tools/test-secureLoginProvisioning.mjs
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

const probe = `
import {
  buildSetPasscodeRequest, canSubmit, confirmationCopyFor,
  credentialActionFor, hasCanonicalDriverId, localPolicyError,
} from '../src/lib/secureLoginProvisioning';

const LEGACY = { key: 'da561bc4deadbeef', displayName: 'MikeS24', companyId: 'co1', companyName: 'LG' };
const SECURE = { key: 'da561bc4deadbeef', driverId: '7f3a-uuid-9c21', displayName: 'MikeS24', companyId: 'co1' };
// A row whose driverId was (wrongly) set to the RTDB key.
const HASH_AS_ID = { key: 'da561bc4deadbeef', driverId: 'da561bc4deadbeef', displayName: 'MikeS24' };

const legacyReq = buildSetPasscodeRequest(LEGACY, 'CorrectHorse7');
const secureReq = buildSetPasscodeRequest(SECURE, 'CorrectHorse7');

console.log(JSON.stringify({
  legacyAction: credentialActionFor(LEGACY),
  secureAction: credentialActionFor(SECURE),
  hashAsIdAction: credentialActionFor(HASH_AS_ID),
  hashAsIdCanonical: hasCanonicalDriverId(HASH_AS_ID),

  legacyHasDriverId: 'driverId' in legacyReq,
  legacyHasLegacyHash: 'legacyHash' in legacyReq,
  legacyApprovedKey: legacyReq.approvedKey,
  legacyKeyAnywhere: JSON.stringify(legacyReq).includes(LEGACY.key),
  legacyTemporary: legacyReq.temporary,
  legacyTemporaryExplicit: 'temporary' in legacyReq,

  secureDriverId: secureReq.driverId,
  secureHasLegacyHash: 'legacyHash' in secureReq,

  reqKeys: Object.keys(legacyReq).sort().join(','),

  legacyDisplayName: legacyReq.displayName,
  legacyCompanyId: legacyReq.companyId,
  legacyCompanyName: legacyReq.companyName,
  // A row with no company must not invent one.
  unboundHasCompanyId: 'companyId' in buildSetPasscodeRequest(
    { key: 'k9', displayName: 'Nobody' }, 'CorrectHorse7'),

  submitOk: canSubmit({ passcode: 'CorrectHorse7', confirm: 'CorrectHorse7', submitting: false }),
  submitMismatch: canSubmit({ passcode: 'CorrectHorse7', confirm: 'Correct', submitting: false }),
  submitWhileBusy: canSubmit({ passcode: 'CorrectHorse7', confirm: 'CorrectHorse7', submitting: true }),
  submitShort: canSubmit({ passcode: 'abc', confirm: 'abc', submitting: false }),
  submitPin: canSubmit({ passcode: '12345', confirm: '12345', submitting: false }),
  policyLongPin: localPolicyError('123456'),
  createCopy: confirmationCopyFor('create_secure_login').join(' '),
}));
`;

const probePath = join(ROOT, 'tools', '.secureLoginProvisioning.probe.mts');
let r = {};
try {
  writeFileSync(probePath, probe, 'utf8');
  r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
  }).trim().split('\n').pop());
} catch (e) {
  check('provisioning probe ran', false, String(e.message).slice(0, 200));
} finally {
  try { rmSync(probePath); } catch { /* best effort */ }
}

// ── 1/7. the two operations are distinguished ────────────────────────────
check('1. a legacy-only row creates a fresh secure identity',
  r.legacyAction === 'create_secure_login', String(r.legacyAction));
check('7. a genuinely secure row uses reset semantics',
  r.secureAction === 'reset_passcode', String(r.secureAction));
check('a driverId equal to the RTDB key is NOT canonical',
  r.hashAsIdCanonical === false && r.hashAsIdAction === 'create_secure_login',
  'a hash-derived id would be treated as identity');

// ── 2/3. no credential-derived value becomes identity ────────────────────
check('2. no existing hash is supplied as driverId',
  r.legacyHasDriverId === false, 'create must not send a driverId');
check('3. the create request carries no legacyHash branch selector',
  r.legacyHasLegacyHash === false,
  'legacyHash writes migratedFromLegacyHashPrefix into the new profile');
check('create sends the exact approved row key, never as driverId',
  r.legacyApprovedKey === 'da561bc4deadbeef' && r.legacyHasDriverId === false,
  `approvedKey=${r.legacyApprovedKey}`);
check('the RTDB key appears only as approvedKey',
  r.legacyKeyAnywhere === true && r.legacyApprovedKey === 'da561bc4deadbeef');
check('a reset sends the canonical id, unchanged',
  r.secureDriverId === '7f3a-uuid-9c21' && r.secureHasLegacyHash === false);

// ── the request targets the intended employee, with their company ───────
// The callable binds the new profile to whatever company it is given, and
// the server's authority step REFUSES to complete a company-bound attempt
// whose shift authority was skipped. So an omitted binding is not a cosmetic
// loss: it silently produces a standalone driver who can never claim a
// shift for the company the admin was looking at when they clicked.
check('the request names the selected employee, not a default or index lookup',
  r.legacyDisplayName === 'MikeS24', String(r.legacyDisplayName));
check('the selected row\'s company binding is CARRIED, not dropped',
  r.legacyCompanyId === 'co1' && r.legacyCompanyName === 'LG',
  `companyId=${r.legacyCompanyId} companyName=${r.legacyCompanyName}`);
check('a row with no company does not acquire one',
  r.unboundHasCompanyId === false,
  'an invented binding would bind a driver to a company nobody selected');

// ── 4. temporary is explicitly false ─────────────────────────────────────
check('4. temporary is present and explicitly false',
  r.legacyTemporaryExplicit === true && r.legacyTemporary === false,
  'the server defaults temporary to TRUE when omitted');

// ── 6/10. the mutation surface is minimal ────────────────────────────────
// The invariant is that NOTHING outside this set is sent — optional fields
// are legitimately absent when the row lacks them. An exact-list assertion
// would fail on a row with no legalName, which is normal.
{
  const ALLOWED = new Set([
    'displayName', 'passcode', 'temporary', 'driverId',
    'legalName', 'companyId', 'companyName', 'approvedKey',
  ]);
  const unexpected = String(r.reqKeys || '').split(',').filter((k) => k && !ALLOWED.has(k));
  check('6/10. no field outside the credential + identity set is sent',
    unexpected.length === 0, `unexpected: ${unexpected.join(', ')}`);
  check('history-bearing fields are never included',
    !/ticket|shift|jsa|dvir|assigned|routes|history/i.test(String(r.reqKeys)), r.reqKeys);
}

// ── 10. form gating ──────────────────────────────────────────────────────
check('10. matching + policy-valid input submits', r.submitOk === true);
check('10. mismatch blocks submission', r.submitMismatch === false);
check('10. double submission is suppressed while in flight', r.submitWhileBusy === false);
check('10. too-short input blocks submission', r.submitShort === false);
check('10. a short numeric PIN blocks submission', r.submitPin === false);
check('a 6-digit numeric passcode is allowed (server permits it)',
  r.policyLongPin === null, String(r.policyLongPin));

// ── the confirmation tells the truth ─────────────────────────────────────
check('create copy states new identity, orphaned history, and no deletion',
  /new secure driver identity/i.test(r.createCopy)
  && /will not appear/i.test(r.createCopy)
  && /Nothing is deleted/i.test(r.createCopy), r.createCopy);

// ── 5/8/9. source pins ───────────────────────────────────────────────────
{
  const src = readFileSync(join(ROOT, 'src/lib/secureLoginProvisioning.ts'), 'utf8');
  check('8. the module never logs, stores, or routes the passcode',
    !/console\.|localStorage|sessionStorage|document\.cookie|analytics|window\.location/.test(src));
  check('9. legacy hash computation is never invoked',
    !/adminComputeLegacyHash/.test(src));
  const admin = readFileSync(join(ROOT, 'src/lib/secureDriverAdmin.ts'), 'utf8');
  check('the callable wrapper still targets adminSetDriverPasscode',
    /adminSetDriverPasscode/.test(admin));
}

// ── the submit path cannot reach any other account operation ─────────────
// Adjacent controls on the same row invite a dashboard account, flip the
// legacy mobile flag, approve a registration, or write RTDB directly. None
// of them may be reachable from creating a secure login: an admin setting a
// passcode must not also, say, email an invitation. Comments are stripped
// first so this matches CODE, never prose describing what is avoided.
{
  const tab = readFileSync(join(ROOT, 'src/components/admin/DriversTab.tsx'), 'utf8');
  const start = tab.indexOf('const handleCreateSecureLogin');
  const end = tab.indexOf('}, [secureTarget,', start);
  check('the create-secure-login handler was located for inspection',
    start > 0 && end > start, `start=${start} end=${end}`);

  const body = tab.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const FORBIDDEN = [
    ['inviteEmployee', /\binviteEmployee\b/],
    ['onInvite', /\bonInvite\b/],
    ['toggleDriverActive', /\btoggleDriverActive\b/],
    ['adminApproveSecure', /\badminApproveSecure\b/],
    ['adminRejectSecure', /\badminRejectSecure\b/],
    ['adminDeleteSecureDriver', /\badminDeleteSecureDriver\b/],
    ['handleRolePick', /\bhandleRolePick\b/],
    ['a direct RTDB write', /\b(?:set|update|remove)\(\s*ref\(/],
    ['a raw httpsCallable', /\bhttpsCallable\(/],
  ];
  for (const [label, re] of FORBIDDEN) {
    check(`the submit path cannot invoke ${label}`, !re.test(body));
  }
  check('the submit path calls adminSetPasscode and builds via the tested layer',
    /adminSetPasscode\(/.test(body) && /buildSetPasscodeRequest\(/.test(body));
  check('the submit path sends exactly the built request, unmodified',
    /adminSetPasscode\(req\)/.test(body), 'a spread or extra field would bypass the builder');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
