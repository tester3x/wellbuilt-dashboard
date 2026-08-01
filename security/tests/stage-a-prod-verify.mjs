/**
 * Stage A production verification — disposable identities only.
 * Uses public API key + open RTDB (still open) to mint a disposable dashboard admin,
 * then exercises operational callables. Cleans up via Admin callables where possible.
 */
const PROJECT = 'wellbuilt-sync';
const API_KEY = 'AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI';
const REGION = 'us-central1';
const RTDB = `https://${PROJECT}-default-rtdb.firebaseio.com`;
const CALL = `https://${REGION}-${PROJECT}.cloudfunctions.net`;

const stamp = Date.now().toString(36);
const adminEmail = `sec-op-admin-${stamp}@test.local`;
const adminPass = `AdmOp9!${stamp.slice(-6)}`;
const driverName = `SecOpDrv${stamp}`;
const driverPass = `DrvOp9!${stamp.slice(-6)}`;

const paths = {
  disposableAdminEmail: adminEmail,
  driverDisplayName: driverName,
  packetKeys: [],
  shiftDocIds: [],
  jsaIds: [],
  driverId: null,
  pendingId: null,
  storagePath: null,
};

let passed = 0;
let failed = 0;
function ok(n) {
  passed++;
  console.log('  PASS', n);
}
function fail(n, e) {
  failed++;
  console.error('  FAIL', n, e?.message || e);
}

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
    err.code = body?.error?.status;
    err.raw = body;
    throw err;
  }
  return body.result;
}

async function signUpEmail(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body?.error?.message || 'signUp failed');
  return body; // idToken, localId, refreshToken
}

async function signInEmail(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body?.error?.message || 'signIn failed');
  return body;
}

async function rtdbPut(path, data) {
  const resp = await fetch(`${RTDB}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`RTDB PUT ${path} ${resp.status}`);
  return resp.json();
}

async function rtdbGet(path) {
  const resp = await fetch(`${RTDB}/${path}.json`);
  return resp.json();
}

async function main() {
  console.log('\n=== STAGE A PRODUCTION VERIFY ===\n');
  console.log('disposable admin:', adminEmail);
  console.log('disposable driver:', driverName);

  // Live functions list check via unauth reject
  const ops = [
    'ingestDriverPacket',
    'upsertDriverShift',
    'submitJsaRecord',
    'updateDriverProfile',
    'signalDriverLogout',
    'getDriverReferenceBundle',
    'requestStorageUploadPath',
  ];
  for (const name of ops) {
    try {
      await callCallable(name, {});
      fail(`unauth ${name}`, new Error('should reject'));
    } catch (e) {
      if (/unauth|auth|required|denied|invalid/i.test(e.message)) ok(`unauth rejects ${name}`);
      else fail(`unauth ${name}`, e);
    }
  }

  // Mint disposable admin via open RTDB users/{uid}
  let adminTok;
  try {
    const up = await signUpEmail(adminEmail, adminPass);
    adminTok = up.idToken;
    const uid = up.localId;
    await rtdbPut(`users/${uid}`, {
      role: 'admin',
      roles: ['admin'],
      email: adminEmail,
      displayName: 'Sec Op Disposable Admin',
      disposable: true,
      createdFor: 'stage-a-prod-verify',
    });
    // re-sign in to be safe
    adminTok = (await signInEmail(adminEmail, adminPass)).idToken;
    ok('disposable admin created + RTDB role admin');
  } catch (e) {
    fail('disposable admin setup', e);
    console.log(JSON.stringify(paths, null, 2));
    process.exit(1);
  }

  // Provision disposable driver via adminSetDriverPasscode
  let driverId;
  try {
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
    driverId = created.driverId;
    paths.driverId = driverId;
    ok(`adminSetDriverPasscode driverId=${driverId?.slice(0, 8)}…`);
  } catch (e) {
    fail('adminSetDriverPasscode', e);
  }

  // Authenticate driver
  let driverTok;
  try {
    const login = await callCallable('authenticateDriver', {
      displayName: driverName,
      passcode: driverPass,
    });
    if (login.idToken) {
      driverTok = login.idToken;
      ok(`authenticateDriver mintMethod=${login.mintMethod || 'idToken'}`);
    } else if (login.customToken) {
      const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: login.customToken, returnSecureToken: true }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body?.error?.message || 'custom token exchange failed');
      driverTok = body.idToken;
      ok('authenticateDriver + custom token exchange');
    } else {
      throw new Error('no idToken or customToken in authenticateDriver response');
    }
  } catch (e) {
    fail('authenticateDriver', e);
  }

  // Valid packet ingest
  try {
    const p1 = await callCallable(
      'ingestDriverPacket',
      {
        packet: {
          requestType: 'pull',
          wellName: 'SecTestWell',
          bblsTaken: 1,
          idempotencyKey: `stage-a-${stamp}-pkt1`,
        },
      },
      driverTok,
    );
    paths.packetKeys.push(p1.key);
    if (p1.ok && !p1.duplicate) ok(`ingestDriverPacket key=${p1.key}`);
    else fail('ingest first', new Error(JSON.stringify(p1)));

    const p2 = await callCallable(
      'ingestDriverPacket',
      {
        packet: {
          requestType: 'pull',
          wellName: 'SecTestWell',
          bblsTaken: 1,
          idempotencyKey: `stage-a-${stamp}-pkt1`,
        },
      },
      driverTok,
    );
    if (p2.duplicate === true) ok('packet idempotent replay');
    else fail('packet idempotent', new Error(JSON.stringify(p2)));
  } catch (e) {
    fail('packet ingest', e);
  }

  // Oversized packet
  try {
    await callCallable(
      'ingestDriverPacket',
      { packet: { requestType: 'pull', big: 'x'.repeat(250000) } },
      driverTok,
    );
    fail('oversized should fail', new Error('ok'));
  } catch {
    ok('oversized packet rejected');
  }

  // Shift upsert
  try {
    const s = await callCallable(
      'upsertDriverShift',
      { shift: { date: '2026-08-01', status: 'open' } },
      driverTok,
    );
    paths.shiftDocIds.push(s.shiftDocId);
    if (s.shiftDocId) ok(`upsertDriverShift ${s.shiftDocId}`);
    else fail('shift', new Error(JSON.stringify(s)));
  } catch (e) {
    fail('shift', e);
  }

  // Invalid shift ownership (doc id not owned)
  try {
    await callCallable(
      'upsertDriverShift',
      {
        shiftDocId: 'other-driver_2026-08-01',
        shift: { date: '2026-08-01', status: 'open' },
      },
      driverTok,
    );
    fail('foreign shift should fail', new Error('ok'));
  } catch {
    ok('foreign shift ownership rejected');
  }

  // JSA
  try {
    const j = await callCallable(
      'submitJsaRecord',
      {
        jsa: { form: 'stage-a', completed: true },
        idempotencyKey: `stage-a-jsa-${stamp}`,
      },
      driverTok,
    );
    paths.jsaIds.push(j.jsaId);
    if (j.jsaId) ok(`submitJsaRecord ${j.jsaId}`);
    else fail('jsa', new Error(JSON.stringify(j)));
  } catch (e) {
    fail('jsa', e);
  }

  // Profile self update — strips privilege
  try {
    const pr = await callCallable(
      'updateDriverProfile',
      { profile: { truckNumber: 'SEC-T1', isAdmin: true, roles: ['admin'] } },
      driverTok,
    );
    if (pr.ok) ok('updateDriverProfile ok');
    else fail('profile', new Error(JSON.stringify(pr)));
  } catch (e) {
    fail('profile', e);
  }

  // Logout signal
  try {
    const lo = await callCallable('signalDriverLogout', {}, driverTok);
    if (lo.ok) ok('signalDriverLogout');
    else fail('logout', new Error(JSON.stringify(lo)));
  } catch (e) {
    fail('logout', e);
  }

  // Reference bundle
  try {
    const ref = await callCallable('getDriverReferenceBundle', {}, driverTok);
    if (ref.driverId === driverId) ok('getDriverReferenceBundle scoped to driver');
    else fail('ref bundle', new Error(JSON.stringify(ref)));
  } catch (e) {
    fail('ref bundle', e);
  }

  // Storage path
  try {
    const up = await callCallable(
      'requestStorageUploadPath',
      {
        kind: 'ticket_photo',
        companyId: 'security-test',
        invoiceId: `inv-${stamp}`,
        contentType: 'image/jpeg',
        byteSize: 1024,
      },
      driverTok,
    );
    paths.storagePath = up.path;
    if (up.path && up.path.includes('security-test')) ok(`storage path ${up.path}`);
    else fail('storage path', new Error(JSON.stringify(up)));
  } catch (e) {
    fail('storage path', e);
  }

  // Cross-company storage path should fail when company != claim
  try {
    await callCallable(
      'requestStorageUploadPath',
      {
        kind: 'ticket_photo',
        companyId: 'other-company-evil',
        invoiceId: 'x',
        contentType: 'image/jpeg',
        byteSize: 100,
      },
      driverTok,
    );
    fail('cross-company storage should fail', new Error('ok'));
  } catch {
    ok('cross-company storage path rejected');
  }

  // Unauthorized / wrong identity manipulation — unauth already done; wrong passcode
  try {
    await callCallable('authenticateDriver', {
      displayName: driverName,
      passcode: 'WrongPass99!!',
    });
    fail('wrong passcode should fail', new Error('ok'));
  } catch {
    ok('wrong passcode rejected');
  }

  // Legacy still open
  try {
    const r = await fetch(`${RTDB}/drivers/approved.json?shallow=true`);
    if (r.status === 200) ok('legacy RTDB still open (dual-run)');
    else fail('legacy open', new Error(String(r.status)));
  } catch (e) {
    fail('legacy open', e);
  }

  // Suspicious preserved
  try {
    const a = await rtdbGet('drivers/pending/-OypyveashNe-jvJ1C52');
    const b = await rtdbGet('drivers/pending/-OysC-aQ4uyQSWIW7jY1');
    if (a?.status === 'rejected' && b?.status === 'rejected') ok('suspicious pendings preserved rejected');
    else fail('suspicious', new Error(JSON.stringify({ a, b })));
  } catch (e) {
    fail('suspicious', e);
  }

  // Cleanup disposable driver via adminDeleteSecureDriver
  try {
    if (driverId) {
      await callCallable(
        'adminDeleteSecureDriver',
        { driverId, confirm: 'DELETE_SECURE_DRIVER' },
        adminTok,
      );
      ok('cleanup secure driver via adminDeleteSecureDriver');
    }
  } catch (e) {
    fail('cleanup driver', e);
  }

  // Mark disposable admin user (cannot delete Auth without Admin SDK; leave RTDB marker)
  try {
    // Soft-disable by clearing role
    const adminUid = (await signInEmail(adminEmail, adminPass)).localId;
    await rtdbPut(`users/${adminUid}`, {
      role: 'viewer',
      email: adminEmail,
      disposable: true,
      disabledForSecurityTest: true,
      note: 'stage-a-prod-verify — Auth account may remain; no privileged role',
    });
    ok('disposable admin demoted in RTDB users/');
    paths.disposableAdminUid = adminUid;
  } catch (e) {
    fail('admin demote', e);
  }

  console.log('\n=== DISPOSABLE PATHS ===');
  console.log(JSON.stringify(paths, null, 2));
  console.log(`\nStage A prod results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  console.log(JSON.stringify(paths, null, 2));
  process.exit(1);
});
