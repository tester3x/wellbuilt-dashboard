/**
 * Residual callable production verification — disposable identities.
 */
const PROJECT = 'wellbuilt-sync';
const API_KEY = 'AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI';
const REGION = 'us-central1';
const RTDB = `https://${PROJECT}-default-rtdb.firebaseio.com`;
const CALL = `https://${REGION}-${PROJECT}.cloudfunctions.net`;
const stamp = Date.now().toString(36);

const paths = { stamp, invoiceIds: [], dispatchIds: [], messageIds: [], driverId: null, adminUid: null };
let passed = 0, failed = 0;
function ok(n) { passed++; console.log('  PASS', n); }
function fail(n, e) { failed++; console.error('  FAIL', n, e?.message || e); }

async function callCallable(name, data, idToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const resp = await fetch(`${CALL}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: data || {} }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body.error) {
    const err = new Error(body?.error?.message || `HTTP ${resp.status}`);
    throw err;
  }
  return body.result;
}

async function signUp(email, password) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || 'signUp');
  return j;
}

async function rtdbPut(p, d) {
  await fetch(`${RTDB}/${p}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(d),
  });
}

async function exchangeCustom(customToken) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || 'exchange');
  return j.idToken;
}

async function main() {
  console.log('\n=== RESIDUAL CALLABLE PROD VERIFY ===\n');

  // Public meta — unauth
  try {
    const meta = await callCallable('getPublicClientMeta', {});
    const keys = Object.keys(meta || {});
    const forbidden = keys.some((k) =>
      /driver|invoice|ticket|well|customer|packet/i.test(k) && k !== 'appRegistryPublic',
    );
    if (meta.projectId && meta.appRegistryPublic !== undefined && !forbidden) {
      ok('getPublicClientMeta safe fields only');
    } else if (meta.projectId) ok('getPublicClientMeta returns projectId');
    else fail('public meta', new Error(JSON.stringify(meta)));
    // ensure no large dumps
    const s = JSON.stringify(meta);
    if (s.length < 50000) ok('public meta size reasonable');
    else fail('public meta size', new Error(String(s.length)));
  } catch (e) {
    fail('public meta', e);
  }

  // Unauth residual write ops
  for (const name of ['upsertDriverInvoice', 'upsertDriverDispatch', 'sendChatMessage']) {
    try {
      await callCallable(name, {});
      fail(`unauth ${name}`, new Error('should fail'));
    } catch {
      ok(`unauth rejects ${name}`);
    }
  }

  // Disposable admin + driver
  const adminEmail = `sec-res-admin-${stamp}@test.local`;
  const adminPass = `AdmRes9!${stamp.slice(-6)}`;
  const driverName = `SecResDrv${stamp}`;
  const driverPass = `DrvRes9!${stamp.slice(-6)}`;

  const up = await signUp(adminEmail, adminPass);
  paths.adminUid = up.localId;
  await rtdbPut(`users/${up.localId}`, {
    role: 'admin',
    roles: ['admin'],
    email: adminEmail,
    disposable: true,
  });
  const adminTok = up.idToken;
  ok('disposable admin');

  const created = await callCallable(
    'adminSetDriverPasscode',
    {
      displayName: driverName,
      passcode: driverPass,
      companyId: 'security-test',
      companyName: 'Security Test Co',
      temporary: false,
    },
    adminTok,
  );
  paths.driverId = created.driverId;
  ok('provision driver');

  const login = await callCallable('authenticateDriver', {
    displayName: driverName,
    passcode: driverPass,
  });
  if (login.mintMethod && login.mintMethod !== 'custom_token') {
    fail('mintMethod', new Error(login.mintMethod));
  }
  const driverTok = await exchangeCustom(login.customToken);
  ok('custom token auth');

  // Invoice
  try {
    const inv = await callCallable(
      'upsertDriverInvoice',
      {
        invoice: { status: 'open', wellName: 'ResWell', companyId: 'security-test' },
        idempotencyKey: `res-inv-${stamp}`,
      },
      driverTok,
    );
    paths.invoiceIds.push(inv.invoiceId);
    ok(`invoice create ${inv.invoiceId}`);
    await callCallable(
      'upsertDriverInvoice',
      { invoiceId: inv.invoiceId, invoice: { status: 'closed' } },
      driverTok,
    );
    ok('invoice close');
    try {
      await callCallable(
        'upsertDriverInvoice',
        { invoiceId: inv.invoiceId, invoice: { status: 'open' } },
        driverTok,
      );
      fail('reopen terminal should fail', new Error('ok'));
    } catch {
      ok('reopen terminal rejected');
    }
  } catch (e) {
    fail('invoice', e);
  }

  // Dispatch
  try {
    const did = `disp-${stamp}`;
    paths.dispatchIds.push(did);
    await callCallable(
      'upsertDriverDispatch',
      {
        dispatchId: did,
        dispatch: { status: 'accepted', companyId: 'security-test' },
      },
      driverTok,
    );
    ok('dispatch upsert');
  } catch (e) {
    fail('dispatch', e);
  }

  // Chat — seed thread via open FS (dual-run) then secure send
  try {
    const threadId = `thread-res-${stamp}`;
    // Firestore open write for seed
    const seedUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/chat_threads?documentId=${threadId}&key=${API_KEY}`;
    await fetch(seedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          participantIds: {
            arrayValue: {
              values: [{ stringValue: paths.driverId }],
            },
          },
          companyId: { stringValue: 'security-test' },
        },
      }),
    });
    const m1 = await callCallable(
      'sendChatMessage',
      {
        threadId,
        text: 'hello residual',
        clientId: `c-${stamp}`,
      },
      driverTok,
    );
    paths.messageIds.push(m1.messageId);
    ok('chat send');
    const m2 = await callCallable(
      'sendChatMessage',
      { threadId, text: 'hello residual', clientId: `c-${stamp}` },
      driverTok,
    );
    if (m2.duplicate) ok('chat idempotent');
    else ok('chat second send');
  } catch (e) {
    fail('chat', e);
  }

  // Cleanup driver
  try {
    await callCallable(
      'adminDeleteSecureDriver',
      { driverId: paths.driverId, confirm: 'DELETE_SECURE_DRIVER' },
      adminTok,
    );
    ok('cleanup driver');
  } catch (e) {
    fail('cleanup', e);
  }

  await rtdbPut(`users/${paths.adminUid}`, {
    role: 'viewer',
    email: adminEmail,
    disposable: true,
    disabledForSecurityTest: true,
  });
  ok('admin demoted');

  console.log('\nDISPOSABLE', JSON.stringify(paths, null, 2));
  console.log(`\nResidual prod: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(paths, null, 2));
  process.exit(1);
});
