/**
 * Source-rules denial for governed JSA collections.
 *
 *   npx firebase emulators:exec --only firestore --project wellbuilt-sync \
 *     "node firestore-rules-tests/test-jsaGovernedCollectionDenies.mjs"
 *
 * Loads the rules wired by firebase.json into the local emulator only.
 * This does not read or write the live project. Admin SDK owner bypass
 * is the callable path; every direct client identity must be denied.
 * An explicit `if false` does not override a different matching allow.
 * These collections have no allow rule, and the catch-all is also false.
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

const UNAUTH = null;
const OWNER = 'Bearer owner';
const USER = `Bearer ${token('ordinary-user-1')}`;
const DRIVER = `Bearer ${token('driver-auth-uid', { kind: 'driver', driverId: 'driver-1', companyId: 'liquid-gold', app: 'jsa' })}`;
const CLAIM = `Bearer ${token('claim-admin-1', { wellbuiltAdmin: true })}`;

const hdrs = (auth) => ({
  'Content-Type': 'application/json',
  ...(auth ? { Authorization: auth } : {}),
});
const s = (v) => ({ stringValue: v });

const PATHS = [
  'jsa_governed_requests/req-governed-1',
  'jsa_job_acknowledgments/ack-governed-1',
];

async function patchDoc(auth, path, fields) {
  const r = await fetch(`${BASE}/${path}`, {
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

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${actual}, want ${expected})`);
};

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is unset. Refusing to run outside the emulator.');
  process.exit(1);
}

for (const path of PATHS) {
  const col = path.split('/')[0];
  check(`ADMIN fixture created ${path}`, await patchDoc(OWNER, path, {
    companyId: s('liquid-gold'), driverId: s('driver-1'),
  }), 200);
  check(`ADMIN can read ${path}`, await getDoc(OWNER, path), 200);

  for (const [label, auth] of [
    ['UNAUTH', UNAUTH],
    ['USER', USER],
    ['DRIVER', DRIVER],
    ['CLAIM', CLAIM],
  ]) {
    check(`${label} get ${col} denied`, await getDoc(auth, path), 403);
    check(`${label} list ${col} denied`, await listCol(auth, col), 403);
    check(`${label} query ${col} denied`, await runQuery(auth, col), 403);
    check(`${label} create ${col} denied`, await patchDoc(auth, `${col}/client-created`, {
      companyId: s('other'),
    }), 403);
    check(`${label} update ${col} denied`, await patchDoc(auth, path, {
      companyId: s('forged'),
    }), 403);
    check(`${label} delete ${col} denied`, await delDoc(auth, path), 403);
  }

  check(`ADMIN still reads ${path} after client attempts`, await getDoc(OWNER, path), 200);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
