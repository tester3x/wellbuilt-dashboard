/**
 * driver_shifts WRITE LOCKDOWN — staged rule matrix.
 *
 *   JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=D:\tmp" \
 *   npx firebase emulators:exec --only firestore --project wellbuilt-sync \
 *     "node firestore-rules-tests/test-driverShiftsWriteLockdown.mjs"
 *
 * This proves BOTH halves of a staged change, which is the only way the stage
 * is meaningful:
 *
 *   DENIED  — every direct client write, for every identity. Shift state is
 *             server-owned now; a client that can set `currentShiftId` can
 *             mint or end a shift outside the authority transaction.
 *   ALLOWED — every read the field apps currently depend on. WB-JSA
 *             (shiftStaleness / requestPeriodBinding), eQuipment, WB-T, the
 *             WB-S day summary and every AppSwitcher read these documents
 *             unauthenticated TODAY. If this half regresses, deploying the
 *             lockdown would break five apps at once.
 *
 * Read closure is a separate cross-app migration and is deliberately not
 * tested or attempted here.
 *
 * Conventions match test-protectedCompanies.mjs: plain REST, unsigned
 * alg:none JWTs, `Bearer owner` for Admin-SDK fixtures that bypass rules.
 */

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PID = 'wellbuilt-sync';
const BASE = `http://${host}/v1/projects/${PID}/databases/(default)/documents`;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, claims = {}) {
  const iat = 1754400000;
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    iss: `https://securetoken.google.com/${PID}`,
    aud: PID, iat, exp: iat + 3600, auth_time: iat,
    sub: uid, user_id: uid,
    firebase: { sign_in_provider: 'password', identities: {} },
    ...claims,
  })}.`;
}

const DRIVER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const DAY = '2026-08-08';
const DOC = `driver_shifts/${DRIVER}_${DAY}`;
const PERIOD = '2026-08-08_211725';

const UNAUTH = null;                       // what WB-S vc22 actually is
const OWNER = 'Bearer owner';              // Admin SDK / the callables
const USER = `Bearer ${token('ordinary-user-1')}`;
const DRIVER_SESSION = `Bearer ${token('driver-auth-uid', {
  kind: 'driver', driverId: DRIVER, companyId: 'liquid-gold',
})}`;
const CLAIM = `Bearer ${token('claim-admin-1', { wellbuiltAdmin: true })}`;

const hdrs = (auth) => ({
  'Content-Type': 'application/json',
  ...(auth ? { Authorization: auth } : {}),
});
const s = (v) => ({ stringValue: v });
const i = (v) => ({ integerValue: String(v) });

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

let pass = 0, fail = 0, allowed = 0, denied = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  if (expected === 200) allowed++; else if (expected === 403) denied++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${actual}, want ${expected})`);
};

// ── fixture via the Admin SDK path the callables use ─────────────────────
check('ADMIN fixture: shift day document created (owner bypasses rules)',
  await patchDoc(OWNER, DOC, {
    driverId: s(DRIVER), companyId: s('liquid-gold'), date: s(DAY),
    currentShiftId: s(PERIOD), odometerMiles: i(287),
  }), 200);

// ══ HALF 1 — EVERY DIRECT CLIENT WRITE IS DENIED ═════════════════════════

const IDENTITIES = [
  ['UNAUTH (what WB-S vc22 is today)', UNAUTH],
  ['USER (authenticated, no claims)', USER],
  ['DRIVER (real WB-S driver session)', DRIVER_SESSION],
  ['CLAIM (wellbuiltAdmin — still a direct client)', CLAIM],
];

for (const [label, auth] of IDENTITIES) {
  // The two writes that would subvert the server authority outright.
  check(`${label}: mint a shift via currentShiftId denied`,
    await patchDoc(auth, DOC, { currentShiftId: s('2026-08-20_080000') }, ['currentShiftId']), 403);
  check(`${label}: self-close via currentShiftId="" denied`,
    await patchDoc(auth, DOC, { currentShiftId: s('') }, ['currentShiftId']), 403);
  // Lifecycle events are server-authored now.
  check(`${label}: append an events array denied`,
    await patchDoc(auth, DOC, {
      events: { arrayValue: { values: [{ mapValue: { fields: { type: s('logout') } } }] } },
    }, ['events']), 403);
  check(`${label}: write odometerMiles directly denied`,
    await patchDoc(auth, DOC, { odometerMiles: i(999) }, ['odometerMiles']), 403);
  check(`${label}: create a NEW day document denied`,
    await patchDoc(auth, `driver_shifts/${DRIVER}_2026-09-01`, { driverId: s(DRIVER) }), 403);
  check(`${label}: whole-document replacement denied`,
    await patchDoc(auth, DOC, { driverId: s(DRIVER), currentShiftId: s(PERIOD) }), 403);
  check(`${label}: delete denied`, await delDoc(auth, DOC), 403);
}

// ══ HALF 2 — EVERY CURRENTLY-REQUIRED READ STILL WORKS ════════════════════
// If any of these regress, deploying the lockdown breaks the field apps.

check('WB-JSA shiftStaleness: unauthenticated origin-day GET still allowed',
  await getDoc(UNAUTH, DOC), 200);
check('WB-JSA requestPeriodBinding: unauthenticated day GET still allowed',
  await getDoc(UNAUTH, `driver_shifts/${DRIVER}_2026-08-09`), 404); // absent, not denied
check('WB-S daySummary: authenticated GET still allowed',
  await getDoc(DRIVER_SESSION, DOC), 200);
check('AppSwitcher: unauthenticated GET still allowed',
  await getDoc(UNAUTH, DOC), 200);
check('eQuipment/WB-T: authenticated GET still allowed',
  await getDoc(USER, DOC), 200);
check('collection list still allowed (read is untouched in this tranche)',
  await listCol(UNAUTH, 'driver_shifts'), 200);
check('collection query still allowed (read is untouched in this tranche)',
  await runQuery(UNAUTH, 'driver_shifts'), 200);

// ══ the server path is unaffected ════════════════════════════════════════
check('ADMIN (owner) still writes — Admin SDK bypasses rules',
  await patchDoc(OWNER, DOC, { currentShiftId: s('') }, ['currentShiftId']), 200);

// ══ no other protected collection reopened ═══════════════════════════════
check('driver_shift_authority still denied to clients',
  await getDoc(DRIVER_SESSION, `driver_shift_authority/${DRIVER}`), 403);
check('platform_admins still denied',
  await getDoc(CLAIM, 'platform_admins/claim-admin-1'), 403);
check('driver_credentials still denied',
  await patchDoc(USER, 'driver_credentials/probe', { a: s('b') }), 403);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`expected-DENIED: ${denied}; expected-ALLOWED: ${allowed}`);
process.exit(fail ? 1 : 0);
