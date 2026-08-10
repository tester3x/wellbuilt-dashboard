/**
 * driver_shift_authority denial matrix — runs INSIDE the Firestore emulator:
 *
 *   npx firebase emulators:exec --only firestore --project wellbuilt-sync \
 *     "node firestore-rules-tests/test-shiftAuthorityRules.mjs"
 *
 * WHY THIS IS WORTH AN EMULATOR RUN. The jest suite asserts the deny rule
 * exists as TEXT. That proves the file says the right thing; it does not prove
 * Firestore enforces it. Only the emulator, loading rules through
 * firebase.json, proves the WIRED rules deny the real operations — and that
 * the deny survives every identity, including one carrying wellbuiltAdmin.
 *
 * THE STAKE. This collection decides whether a shift is open. A client that
 * could READ it would learn that answer without the server's decision; a
 * client that could WRITE it could mint or end a shift directly, which is the
 * entire race the collection exists to remove. Every access must be 403.
 *
 * Same conventions as test-protectedCompanies.mjs: plain REST, unsigned
 * alg:none JWTs (the emulator decodes them), `Bearer owner` for Admin-SDK
 * fixture writes that bypass rules.
 */

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PID = 'wellbuilt-sync';
const BASE = `http://${host}/v1/projects/${PID}/databases/(default)/documents`;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, claims = {}) {
  const header = { alg: 'none', typ: 'JWT' };
  const iat = 1754400000;
  const payload = {
    iss: `https://securetoken.google.com/${PID}`,
    aud: PID, iat, exp: iat + 3600, auth_time: iat,
    sub: uid, user_id: uid,
    firebase: { sign_in_provider: 'password', identities: {} },
    ...claims,
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

const DRIVER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const PERIOD = '2026-08-08_211725';
const AUTHORITY = `driver_shift_authority/${DRIVER}`;

const UNAUTH = null;
const OWNER = 'Bearer owner';
const USER = `Bearer ${token('ordinary-user-1')}`;
// A driver-shaped session — what WB-S actually holds in the field.
const DRIVER_SESSION = `Bearer ${token('driver-auth-uid', { kind: 'driver', driverId: DRIVER, companyId: 'liquid-gold' })}`;
// Even a real platform admin is still a DIRECT CLIENT here. Admin work goes
// through callables, and the Admin SDK bypasses rules entirely.
const CLAIM = `Bearer ${token('claim-admin-1', { wellbuiltAdmin: true })}`;

const hdrs = (auth) => ({
  'Content-Type': 'application/json',
  ...(auth ? { Authorization: auth } : {}),
});
const s = (v) => ({ stringValue: v });
const i = (v) => ({ integerValue: String(v) });
const b = (v) => ({ booleanValue: v });
const nul = () => ({ nullValue: null });

async function patchDoc(auth, path, fields, mask = null) {
  const qs = mask ? '?' + mask.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&') : '';
  const r = await fetch(`${BASE}/${path}${qs}`, {
    method: 'PATCH', headers: hdrs(auth), body: JSON.stringify({ fields }),
  });
  return r.status;
}
const getDoc = async (auth, path) => (await fetch(`${BASE}/${path}`, { headers: hdrs(auth) })).status;
const listCol = async (auth, col) => (await fetch(`${BASE}/${col}`, { headers: hdrs(auth) })).status;
const delDoc = async (auth, path) =>
  (await fetch(`${BASE}/${path}`, { method: 'DELETE', headers: hdrs(auth) })).status;
async function runQuery(auth, collectionId) {
  const r = await fetch(`${BASE}:runQuery`, {
    method: 'POST', headers: hdrs(auth),
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }] } }),
  });
  return r.status;
}

let pass = 0, fail = 0, deniedTotal = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  if (expected === 403) deniedTotal++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${actual}, want ${expected})`);
};

// ── fixture via owner (Admin SDK path — bypasses rules by design) ─────────
check('ADMIN fixture: authority record created (owner bypasses rules)',
  await patchDoc(OWNER, AUTHORITY, {
    driverId: s(DRIVER), companyId: s('liquid-gold'), initialized: b(true),
    openPeriodId: nul(), originLocalDate: nul(), lastClosedPeriodId: s(PERIOD), version: i(1),
  }), 200);

// ══ EVERY IDENTITY, EVERY OPERATION → DENIED ═════════════════════════════

const IDENTITIES = [
  ['UNAUTH (what an unauthenticated client is)', UNAUTH],
  ['USER (ordinary authenticated client)', USER],
  ['DRIVER (a real WB-S driver session — its OWN record)', DRIVER_SESSION],
  ['CLAIM (carries wellbuiltAdmin:true — still a direct client)', CLAIM],
];

for (const [label, auth] of IDENTITIES) {
  check(`${label}: get own authority record denied`, await getDoc(auth, AUTHORITY), 403);
  check(`${label}: list collection denied`, await listCol(auth, 'driver_shift_authority'), 403);
  check(`${label}: query collection denied`, await runQuery(auth, 'driver_shift_authority'), 403);
  check(`${label}: create a NEW authority record denied`,
    await patchDoc(auth, 'driver_shift_authority/brand-new-driver',
      { driverId: s('brand-new-driver'), initialized: b(true), version: i(1) }), 403);
  // The two writes that would actually subvert the invariant:
  check(`${label}: mint an open period denied`,
    await patchDoc(auth, AUTHORITY, { openPeriodId: s('2026-08-20_080000') }, ['openPeriodId']), 403);
  check(`${label}: clear the pointer (self-close) denied`,
    await patchDoc(auth, AUTHORITY, { openPeriodId: nul() }, ['openPeriodId']), 403);
  // Flipping `initialized` would turn "unverifiable" into a clean "none",
  // which is precisely how a second concurrent shift gets minted.
  check(`${label}: forge initialized=true denied`,
    await patchDoc(auth, AUTHORITY, { initialized: b(true) }, ['initialized']), 403);
  check(`${label}: whole-document replacement denied`,
    await patchDoc(auth, AUTHORITY, { driverId: s(DRIVER), initialized: b(true), version: i(99) }), 403);
  check(`${label}: delete denied`, await delDoc(auth, AUTHORITY), 403);
}

// A driver may not reach ANOTHER driver's record either — there is no
// owner-matching rule to bypass, because there is no allow rule at all.
check('DRIVER: another driver\'s record denied',
  await getDoc(DRIVER_SESSION, 'driver_shift_authority/11111111-2222-3333-4444-555555555555'), 403);

// The Admin SDK stays unconstrained — this is the path the callables use.
check('ADMIN (owner) still writes the authority record — rules do not bind Admin SDK',
  await patchDoc(OWNER, AUTHORITY, { version: i(2) }, ['version']), 200);
check('ADMIN (owner) still reads it', await getDoc(OWNER, AUTHORITY), 200);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`expected-DENIED cases: ${deniedTotal}`);
process.exit(fail ? 1 : 0);
