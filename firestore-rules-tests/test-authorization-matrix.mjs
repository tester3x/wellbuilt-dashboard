/**
 * Emulator authorization matrix against the files wired in firebase.json.
 *
 *   set JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=D:\tmp
 *   npx firebase emulators:exec --only firestore,database --project wellbuilt-sync "node firestore-rules-tests/test-authorization-matrix.mjs"
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fj = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));
if (fj.firestore.rules !== 'firestore.rules' || fj.database.rules !== 'database.rules.json') {
  console.error('firebase.json is not wired to the tested rule files');
  process.exit(1);
}

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const RTDB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
const PID = 'wellbuilt-sync';
const FS = `http://${FS_HOST}/v1/projects/${PID}/databases/(default)/documents`;
const RTDB = `http://${RTDB_HOST}/`;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, claims = {}) {
  const iat = 1754400000;
  const payload = {
    iss: `https://securetoken.google.com/${PID}`,
    aud: PID,
    iat,
    exp: iat + 3600,
    auth_time: iat,
    sub: uid,
    user_id: uid,
    firebase: { sign_in_provider: 'custom', identities: {} },
    ...claims,
  };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
}

const UNAUTH = null;
const DRIVER_A = `Bearer ${token('driver_aaa', { kind: 'driver', driverId: 'drv-a', companyId: 'liquid-gold' })}`;
const DRIVER_B = `Bearer ${token('driver_bbb', { kind: 'driver', driverId: 'drv-b', companyId: 'acme-eog-test' })}`;
const STAFF = `Bearer ${token('staff-1', { role: 'admin', wellbuiltAdmin: true })}`;
const RANDOM_USER = `Bearer ${token('random-user')}`;

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

async function fsGet(path, auth) {
  const r = await fetch(`${FS}/${path}`, {
    headers: auth ? { Authorization: auth } : {},
  });
  return r.status;
}
async function fsPatch(path, fields, auth) {
  const r = await fetch(`${FS}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ fields }),
  });
  return r.status;
}
async function rtdbGet(path, auth) {
  const url = `http://${RTDB_HOST}/${path}.json?ns=${PID}`;
  const r = await fetch(url, { headers: auth ? { Authorization: auth } : {} });
  return r.status;
}

const RID = `${'C'.repeat(20)}${'d'.repeat(20)}-_e`;
const receipt = {
  receiptVersion: { integerValue: '1' },
  requestId: { stringValue: RID },
  jobDocId: { stringValue: 'INV_123' },
  haulGroupId: { stringValue: 'hg9' },
  companyId: { stringValue: 'liquid-gold' },
  driverHash: { stringValue: 'da561bc4xxxx' },
  shiftId: { stringValue: '2026-08-06_060000' },
  operator: { stringValue: 'SLAWSON' },
  jsaRecordId: { stringValue: '1754470000000' },
  completedAt: { stringValue: '2026-08-16T09:12:00.000Z' },
  completionType: { stringValue: 'signed_submission' },
};

// JSA receipt lifecycle (unauthenticated exact GET + create-only)
check('jsa receipt create unauth', (await fsPatch(`jsa_read_receipts/${RID}`, receipt, UNAUTH)) === 200);
check('jsa receipt exact get unauth', (await fsGet(`jsa_read_receipts/${RID}`, UNAUTH)) === 200);
check('jsa receipt list denied', (await fetch(`${FS}/jsa_read_receipts`).then((r) => r.status)) === 403);

// Closed identity trees
check('unauth credentials denied', (await fsGet('driver_credentials/x', UNAUTH)) === 403);
check('random user credentials denied', (await fsGet('driver_credentials/x', RANDOM_USER)) === 403);
check('unauth invoice denied', (await fsGet('invoices/i1', UNAUTH)) === 403);
check('random user invoice denied', (await fsGet('invoices/i1', RANDOM_USER)) === 403);
check('cross-company invoice create denied',
  (await fsPatch('invoices/i-x', {
    companyId: { stringValue: 'liquid-gold' },
    driverId: { stringValue: 'drv-b' },
  }, DRIVER_B)) === 403);

// Seed an invoice as DRIVER_A, then prove immutable driverId/companyId.
{
  const create = await fsPatch('invoices/i-own', {
    companyId: { stringValue: 'liquid-gold' },
    driverId: { stringValue: 'drv-a' },
  }, DRIVER_A);
  check('owner invoice create denied (CF-only)', create === 403);
  const stealId = await fsPatch('invoices/i-own', {
    companyId: { stringValue: 'liquid-gold' },
    driverId: { stringValue: 'drv-b' },
  }, DRIVER_A);
  check('invoice driverId mutation denied', stealId === 403);
  const stealCo = await fsPatch('invoices/i-own', {
    companyId: { stringValue: 'acme-eog-test' },
    driverId: { stringValue: 'drv-a' },
  }, DRIVER_A);
  check('invoice companyId mutation denied', stealCo === 403);
  const jsa = await fsPatch('jsas/j1', {
    driverId: { stringValue: 'drv-a' },
  }, DRIVER_A);
  check('jsa create without company denied', jsa === 403);
}

// RTDB cases in this file are NOT authorization proof. Run
// rtdb-rules-tests/test-rtdb-query-matrix.mjs with --only database.
console.log('NOTE RTDB authorization is proven by rtdb-rules-tests/test-rtdb-query-matrix.mjs (database emulator). This file does not treat 200 null as allow.');

console.log(`authorization-matrix ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
