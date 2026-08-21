/**
 * RTDB emulator query matrix. Must run with the database emulator:
 *
 *   set JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=D:\tmp
 *   npx firebase emulators:exec --only database --project wellbuilt-sync "node rtdb-rules-tests/test-rtdb-query-matrix.mjs"
 *
 * Unauthenticated requests MUST pass auth=null. Omitting auth uses the
 * admin namespace and returns 200 null even when .read is false — that
 * is NOT authorization proof.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
// The emulator binds rules to the configured instance id
// (wellbuilt-sync-default-rtdb). ns=wellbuilt-sync is a DIFFERENT
// namespace and gets the default-open rules — that was the 16b 200-null
// false proof.
const PID = 'wellbuilt-sync-default-rtdb';
const BASE = `http://${HOST}`;

const rules = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'database.rules.json'), 'utf8');
assert.match(rules, /"\.indexOn":\s*\[\s*"companyId"/);
assert.match(rules, /query\.orderByChild == 'companyId'/);

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(uid, claims = {}) {
  const iat = 1754400000;
  const payload = {
    iss: 'https://securetoken.google.com/wellbuilt-sync',
    aud: 'wellbuilt-sync',
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

const DRIVER_A = jwt('driver_aaa', { kind: 'driver', driverId: 'drv-a', companyId: 'liquid-gold' });
const DRIVER_B = jwt('driver_bbb', { kind: 'driver', driverId: 'drv-b', companyId: 'acme-eog-test' });

async function adminPut(path, body) {
  const r = await fetch(`${BASE}/${path}.json?ns=${PID}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`admin PUT ${path} ${r.status} ${await r.text()}`);
}

async function get(path, auth, extra = '') {
  const authQ = auth === null ? 'null' : encodeURIComponent(auth);
  const url = `${BASE}/${path}.json?ns=${PID}&auth=${authQ}${extra}`;
  const r = await fetch(url, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, text, json };
}

function denied(r) {
  return r.status === 401 || r.status === 403 || /Permission denied/i.test(r.text);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

{
  const loaded = await fetch(`${BASE}/.settings/rules.json?ns=${PID}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  const loadedText = await loaded.text();
  check(
    'emulator loaded companyId indexOn for outgoing',
    /companyId/.test(loadedText) && /packets/.test(loadedText),
    loadedText.slice(0, 180),
  );
}

await adminPut('packets/outgoing/response_20260816_120000_Gab1', {
  wellName: 'Gab 1',
  companyId: 'liquid-gold',
  status: 'success',
});
await adminPut('packets/outgoing/response_20260816_120000_Other', {
  wellName: 'Other',
  companyId: 'acme-eog-test',
  status: 'success',
});
await adminPut('packets/processed/20260816_120000_WellA_abc123', {
  wellName: 'Gab 1',
  companyId: 'liquid-gold',
  driverId: 'drv-a',
});

{
  const r = await get('', null);
  check('unauth rtdb root denied', denied(r), `${r.status} ${String(r.text).slice(0, 80)}`);
}

{
  const r = await get('well_config', DRIVER_A);
  check(
    'signed-in driver can read well_config (auth != null probe)',
    r.status === 200,
    `${r.status} ${String(r.text).slice(0, 160)}`,
  );
}

{
  const r = await get('packets/outgoing', DRIVER_A, '&orderBy="companyId"&equalTo="liquid-gold"');
  check(
    'correct-company outgoing query allowed',
    r.status === 200 && r.json && r.json.response_20260816_120000_Gab1 && !r.json.response_20260816_120000_Other,
    `${r.status} ${String(r.text).slice(0, 160)}`,
  );
}

{
  const r = await get('packets/outgoing', DRIVER_A, '&orderBy="companyId"&equalTo="acme-eog-test"');
  check('wrong-company outgoing query denied', denied(r), `${r.status} ${String(r.text).slice(0, 160)}`);
}

{
  const r = await get('packets/outgoing', DRIVER_A);
  check('missing-company unscoped outgoing list denied', denied(r), `${r.status} ${String(r.text).slice(0, 160)}`);
}

{
  const r = await get('packets/processed', DRIVER_A, '&orderBy="companyId"&equalTo="liquid-gold"');
  check(
    'correct-company processed query allowed',
    r.status === 200 && r.json && r.json['20260816_120000_WellA_abc123'],
    `${r.status} ${String(r.text).slice(0, 160)}`,
  );
}

{
  const r = await get('packets/processed', DRIVER_B, '&orderBy="companyId"&equalTo="acme-eog-test"');
  const leaked = r.json && r.json['20260816_120000_WellA_abc123'];
  check(
    'cross-company processed query does not leak liquid-gold packets',
    denied(r) || (r.status === 200 && !leaked),
    `${r.status} ${String(r.text).slice(0, 160)}`,
  );
}

{
  const r = await get('packets/incoming', DRIVER_A);
  check('incoming remains closed even for signed-in drivers', denied(r), `${r.status} ${String(r.text).slice(0, 80)}`);
}

console.log(`rtdb-query-matrix ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
if (pass < 7) {
  console.error('RTDB matrix did not prove the required company query allow/deny cases');
  process.exit(1);
}
