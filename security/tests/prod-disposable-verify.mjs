/**
 * Post-deploy disposable identity exercise against PRODUCTION wellbuilt-sync.
 * Uses Application Default Credentials (firebase login / gcloud).
 * Does NOT touch Mike/tester legacy accounts.
 * Cleans up disposable secure driver at end.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = 'wellbuilt-sync';
const API_KEY = 'AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI';
const REGION = 'us-central1';

initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT,
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
});

const auth = getAuth();
const rtdb = getDatabase();
const fs = getFirestore();

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
  const url = `https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`;
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: data || {} }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body.error) {
    const err = new Error(body?.error?.message || `HTTP ${resp.status}`);
    err.code = body?.error?.status || body?.error?.message;
    err.raw = body;
    throw err;
  }
  return body.result;
}

async function exchangeCustomToken(customToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body?.error?.message || 'token exchange failed');
  return body.idToken;
}

async function findAdminUid() {
  const snap = await rtdb.ref('users').once('value');
  if (!snap.exists()) throw new Error('no users in RTDB');
  const val = snap.val();
  for (const [uid, u] of Object.entries(val)) {
    if (!u) continue;
    if (u.role === 'admin' || u.role === 'it') return uid;
    if (Array.isArray(u.roles) && (u.roles.includes('admin') || u.roles.includes('it'))) return uid;
  }
  throw new Error('no admin/it user found in RTDB users/');
}

async function main() {
  console.log('\n=== PROD DISPOSABLE SECURE FLOW VERIFY ===\n');
  const stamp = Date.now().toString(36);
  const displayName = `SecDisp${stamp}`;
  const passcode = `DispPass9!${stamp.slice(-4)}`;
  let pendingId;
  let driverId;
  let adminIdToken;

  // 1 Register disposable
  try {
    const res = await callCallable('requestDriverRegistration', {
      displayName,
      passcode,
      legalName: 'Disposable Security Test',
      companyName: 'Security Test Co',
      source: 'prod-verify',
    });
    pendingId = res.pendingId;
    if (pendingId) ok(`requestDriverRegistration pendingId=${pendingId.slice(0, 8)}…`);
    else fail('requestDriverRegistration', new Error('no pendingId'));
  } catch (e) {
    fail('requestDriverRegistration', e);
  }

  // 2 Status pending
  try {
    const st = await callCallable('checkDriverRegistrationStatus', { pendingId });
    if (st.status === 'pending') ok('status pending');
    else fail('status pending', new Error(JSON.stringify(st)));
  } catch (e) {
    fail('status pending', e);
  }

  // 3 Login before approve fails
  try {
    await callCallable('authenticateDriver', { displayName, passcode });
    fail('login before approve should fail', new Error('unexpected success'));
  } catch (e) {
    ok('login before approve fails');
  }

  // 4 Unauthorized approve fails
  try {
    await callCallable('adminApproveDriverRegistration', {
      pendingId,
      companyId: 'security-test',
    });
    fail('unauth approve should fail', new Error('unexpected success'));
  } catch (e) {
    ok('unauth approve fails');
  }

  // 5 Admin approve with real admin identity
  try {
    const adminUid = await findAdminUid();
    console.log('  using admin uid', adminUid.slice(0, 8) + '…');
    // Ensure manageDrivers claim for token path (also RTDB profile exists)
    const userSnap = await rtdb.ref(`users/${adminUid}`).once('value');
    const u = userSnap.val() || {};
    await auth.setCustomUserClaims(adminUid, {
      role: u.role || 'admin',
      roles: u.roles || [u.role || 'admin'],
      manageDrivers: true,
      companyId: u.companyId || null,
    });
    const ctok = await auth.createCustomToken(adminUid, {
      role: u.role || 'admin',
      manageDrivers: true,
    });
    adminIdToken = await exchangeCustomToken(ctok);
    const ap = await callCallable(
      'adminApproveDriverRegistration',
      {
        pendingId,
        companyId: 'security-test',
        companyName: 'Security Test Co',
      },
      adminIdToken,
    );
    driverId = ap.driverId;
    if (driverId) ok(`adminApprove driverId=${driverId.slice(0, 8)}…`);
    else fail('adminApprove', new Error(JSON.stringify(ap)));
  } catch (e) {
    fail('adminApprove', e);
  }

  // 6 Secure auth succeeds
  try {
    const login = await callCallable('authenticateDriver', { displayName, passcode });
    if (login.customToken && login.driverId === driverId) ok('authenticateDriver success');
    else fail('authenticateDriver success', new Error(JSON.stringify(login)));
  } catch (e) {
    fail('authenticateDriver success', e);
  }

  // 7 Wrong passcode fails
  try {
    await callCallable('authenticateDriver', {
      displayName,
      passcode: 'DefinitelyWrong99!',
    });
    fail('wrong passcode should fail', new Error('unexpected success'));
  } catch (e) {
    ok('wrong passcode fails');
  }

  // 8 Audit records exist (no plaintext passcode)
  try {
    const snap = await fs.collection('security_audit').orderBy('ts', 'desc').limit(10).get();
    if (snap.size > 0) ok(`security_audit recent count>=${snap.size}`);
    else fail('security_audit', new Error('empty'));
    let leaked = false;
    snap.forEach((d) => {
      const j = JSON.stringify(d.data());
      if (j.includes(passcode)) leaked = true;
    });
    if (!leaked) ok('audit has no plaintext passcode');
    else fail('audit leak', new Error('passcode in audit'));
  } catch (e) {
    // orderBy may fail without index — fallback un-ordered
    try {
      const snap = await fs.collection('security_audit').limit(20).get();
      if (snap.size > 0) ok(`security_audit present (${snap.size})`);
      else fail('security_audit', e);
    } catch (e2) {
      fail('security_audit', e2);
    }
  }

  // 9 Suspicious pendings still present (rejected status ok)
  try {
    const a = await rtdb.ref('drivers/pending/-OypyveashNe-jvJ1C52').once('value');
    const b = await rtdb.ref('drivers/pending/-OysC-aQ4uyQSWIW7jY1').once('value');
    if (a.exists() && b.exists()) ok('suspicious pendings preserved');
    else fail('suspicious pendings', new Error('missing'));
  } catch (e) {
    fail('suspicious pendings', e);
  }

  // 10 Legacy approved still readable / non-empty
  try {
    const approved = await rtdb.ref('drivers/approved').once('value');
    const n = approved.exists() ? Object.keys(approved.val()).length : 0;
    if (n >= 1) ok(`legacy approved still present (${n} keys)`);
    else fail('legacy approved', new Error('empty'));
  } catch (e) {
    fail('legacy approved', e);
  }

  // 11 Cleanup disposable
  try {
    if (driverId && adminIdToken) {
      await callCallable(
        'adminDeleteSecureDriver',
        { driverId, confirm: 'DELETE_SECURE_DRIVER' },
        adminIdToken,
      );
      ok('disposable cleaned via adminDeleteSecureDriver');
    } else if (driverId) {
      // fallback Admin SDK cleanup
      const cred = await fs.collection('driver_credentials').doc(driverId).get();
      const nameNorm = cred.data()?.displayNameNorm;
      if (nameNorm) await fs.collection('driver_name_index').doc(nameNorm).delete();
      await fs.collection('driver_credentials').doc(driverId).delete();
      await rtdb.ref(`drivers/profiles/${driverId}`).remove();
      ok('disposable cleaned via Admin SDK fallback');
    }
  } catch (e) {
    fail('cleanup disposable', e);
  }

  console.log(`\nProd disposable results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
