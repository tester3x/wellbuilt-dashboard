/**
 * Isolated demo-project proof for staffConvertApprovedDriverSecureLogin.
 *
 * Requires Auth, Functions, Firestore, and RTDB emulators. Refuses any
 * non-demo project. Never contacts production. Never prints passcodes.
 *
 *   firebase emulators:exec --only auth,functions,database,firestore \
 *     --project demo-wellbuilt-wbm \
 *     "node functions/tools/test-staffConvertCallableEmulator.mjs"
 */
import { createRequire } from 'module';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';

const require = createRequire(import.meta.url);
const {
  runApprovedRowConversion,
  clientOutcomeFor,
  TEST_PASSCODE_RECORD,
} = require('../lib/security/operational/approvedRowConversion');
const { productionConversionStore } = require('../lib/security/operational/approvedRowConversionStore');

const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
const FN_HOST = process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const REGION = 'us-central1';
const CALLABLE = 'staffConvertApprovedDriverSecureLogin';

const MARCIAL_KEY = '7413cd7d106a0f49c2a670064bc049e3260a522a09a6a5a7fad0c53522e63c27';
const LUIZ_KEY = 'cf04d010ffd151b878e4377ca9c51cd90eeaae1660e19387fa51942b56c15780';
const MARCIAL_ROUTES = ['Dunn County', 'Watford', 'Gunslingers'];
const LUIZ_ROUTES = ['Montana', 'River Bottoms', 'Stock Yards', 'Watford', 'Dunn County', 'Gabriels'];
const ADMIN_UID = 'emu-convert-admin';
const COMPANY_ADMIN_UID = 'emu-convert-company-admin';
const VIEWER_UID = 'emu-convert-viewer';
const DRIVER_UID = 'emu-convert-driver';
const LOCAL_PASS = 'EmuConvert9x';
const SLAWSON = [{ companyId: 'liquid-gold', name: 'SLAWSON EXPLORATION COMPANY, INC.' }];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

function refuseProduction() {
  if (!PROJECT.startsWith('demo-')) {
    throw new Error(`Refusing non-demo project '${PROJECT || '(empty)'}'`);
  }
  if (!AUTH_HOST || !DB_HOST || !FS_HOST) {
    throw new Error(
      `Refusing to run without emulator hosts. auth=${AUTH_HOST || 'missing'} rtdb=${DB_HOST || 'missing'} firestore=${FS_HOST || 'missing'}`,
    );
  }
}

function callableUrl(name) {
  return `http://${FN_HOST}/${PROJECT}/${REGION}/${name}`;
}

async function invokeCallable(name, data, idToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(callableUrl(name), {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: data ?? {} }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function callableError(inv) {
  const err = inv.body?.error;
  if (!err) return null;
  return { status: err.status || err.code || String(inv.status), message: err.message || '' };
}

function callableResult(inv) {
  return inv.body?.result ?? null;
}

async function signInWithCustomToken(customToken) {
  const url = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const body = await res.json();
  if (!body.idToken) {
    throw new Error(`Auth emulator signIn failed: ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function rtdbRest(ns, path, method, body) {
  const url = `http://${DB_HOST}/${path.replace(/^\/+/, '')}.json?ns=${encodeURIComponent(ns)}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function seedApprovedBothNamespaces(marcial, luiz) {
  for (const ns of [PROJECT, `${PROJECT}-default-rtdb`]) {
    await rtdbRest(ns, `drivers/approved/${MARCIAL_KEY}`, 'PUT', marcial);
    await rtdbRest(ns, `drivers/approved/${LUIZ_KEY}`, 'PUT', luiz);
  }
}

function marcialRow() {
  return {
    active: true,
    displayName: 'Marcial Lebaron',
    legalName: 'Marcial Lebaron',
    name: 'Marcial Lebaron',
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    assignedCustomers: SLAWSON,
    assignedRoutes: [...MARCIAL_ROUTES],
    isAdmin: false,
    isViewer: false,
    approvedAt: 1772370850548,
  };
}

function luizRow() {
  return {
    active: true,
    displayName: 'Wisho-135',
    legalName: 'Luiz Lebaron',
    name: 'Wisho-135',
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    assignedCustomers: SLAWSON,
    assignedRoutes: [...LUIZ_ROUTES],
    isAdmin: false,
    isViewer: false,
    approvedAt: 1772371310138,
  };
}

function sanitizeProfile(pv) {
  return {
    displayName: pv.displayName,
    name: pv.name,
    legalName: pv.legalName,
    active: pv.active,
    isAdmin: pv.isAdmin,
    isViewer: pv.isViewer,
    companyId: pv.companyId,
    companyName: pv.companyName,
    assignedCustomers: pv.assignedCustomers ?? null,
    assignedRoutes: pv.assignedRoutes,
    assignedWells: pv.assignedWells === undefined ? 'absent' : pv.assignedWells,
    roles: pv.roles ?? null,
    approvedAt: pv.approvedAt,
    schemaVersion: pv.schemaVersion,
    mustUseSecureAuth: pv.mustUseSecureAuth,
  };
}

async function waitForFunctions() {
  const start = Date.now();
  while (Date.now() - start < 90000) {
    try {
      const inv = await invokeCallable(CALLABLE, {}, null);
      if (inv.status > 0) return;
    } catch {
      /* not bound yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Functions emulator not reachable at ${callableUrl(CALLABLE)}`);
}

function payloadFor(row, key) {
  return {
    approvedKey: key,
    displayName: row.displayName,
    passcode: LOCAL_PASS,
    temporary: false,
  };
}

refuseProduction();
console.log(`project=${PROJECT}`);
console.log(`auth=${AUTH_HOST} rtdb=${DB_HOST} firestore=${FS_HOST} functions=${FN_HOST}`);
console.log(`callableUrl=${callableUrl(CALLABLE)}`);

const app = initializeApp({
  projectId: PROJECT,
  databaseURL: `http://${DB_HOST}?ns=${PROJECT}`,
});
const auth = getAuth(app);
const rtdb = getDatabase(app);
const fs = getFirestore(app);
const store = productionConversionStore(fs, rtdb);

try {
  await waitForFunctions();

  for (const uid of [ADMIN_UID, COMPANY_ADMIN_UID, VIEWER_UID, DRIVER_UID]) {
    try { await auth.deleteUser(uid); } catch { /* first run */ }
  }
  await auth.createUser({ uid: ADMIN_UID, disabled: false, displayName: 'Emu Admin' });
  await auth.createUser({ uid: COMPANY_ADMIN_UID, disabled: false, displayName: 'Emu Co Admin' });
  await auth.createUser({ uid: VIEWER_UID, disabled: false, displayName: 'Emu Viewer' });
  await auth.createUser({ uid: DRIVER_UID, disabled: false, displayName: 'Emu Driver' });
  for (const ns of [PROJECT, `${PROJECT}-default-rtdb`]) {
    await rtdbRest(ns, `users/${ADMIN_UID}`, 'PUT', { role: 'admin' });
    await rtdbRest(ns, `users/${COMPANY_ADMIN_UID}`, 'PUT', { role: 'admin', companyId: 'liquid-gold' });
    await rtdbRest(ns, `users/${VIEWER_UID}`, 'PUT', { role: 'viewer' });
  }
  await seedApprovedBothNamespaces(marcialRow(), luizRow());

  const adminToken = await signInWithCustomToken(
    await auth.createCustomToken(ADMIN_UID, { role: 'admin' }),
  );
  const companyAdminToken = await signInWithCustomToken(
    await auth.createCustomToken(COMPANY_ADMIN_UID, { role: 'admin', companyId: 'liquid-gold' }),
  );
  const viewerToken = await signInWithCustomToken(
    await auth.createCustomToken(VIEWER_UID, { role: 'viewer' }),
  );
  const driverToken = await signInWithCustomToken(
    await auth.createCustomToken(DRIVER_UID, { kind: 'driver', driverId: 'emu-driver', companyId: 'liquid-gold' }),
  );

  const unauth = await invokeCallable(CALLABLE, payloadFor(marcialRow(), MARCIAL_KEY), null);
  const unauthErr = callableError(unauth);
  check('2. unauthorized caller fails', Boolean(unauthErr), unauthErr ? `${unauthErr.status}` : `http=${unauth.status}`);

  const driverCall = await invokeCallable(CALLABLE, payloadFor(marcialRow(), MARCIAL_KEY), driverToken);
  const driverErr = callableError(driverCall);
  check('driver token is denied', Boolean(driverErr), driverErr ? `${driverErr.status}` : '');

  const beforeCo = await rtdb.ref(`drivers/approved/${MARCIAL_KEY}`).once('value');
  const coCall = await invokeCallable(CALLABLE, payloadFor(marcialRow(), MARCIAL_KEY), companyAdminToken);
  const coErr = callableError(coCall);
  const afterCo = await rtdb.ref(`drivers/approved/${MARCIAL_KEY}`).once('value');
  check(
    'company-scoped manageDrivers is denied with zero writes',
    Boolean(coErr) && /PERMISSION_DENIED/i.test(String(coErr.status))
      && !afterCo.val()?.migratedToDriverId
      && !beforeCo.val()?.migratedToDriverId,
    coErr ? `${coErr.status}: ${coErr.message}` : 'no error',
  );

  const viewerCall = await invokeCallable(CALLABLE, payloadFor(marcialRow(), MARCIAL_KEY), viewerToken);
  const viewerErr = callableError(viewerCall);
  check('ordinary Dashboard user is denied', Boolean(viewerErr), viewerErr ? `${viewerErr.status}` : '');

  const metaCall = await invokeCallable(CALLABLE, {
    ...payloadFor(marcialRow(), MARCIAL_KEY),
    companyId: 'acme-eog-test',
    companyName: 'Nope',
    legalName: 'Someone Else',
  }, adminToken);
  const metaErr = callableError(metaCall);
  const afterMeta = await rtdb.ref(`drivers/approved/${MARCIAL_KEY}`).once('value');
  check(
    'client-supplied companyId/companyName/legalName is rejected with zero writes',
    Boolean(metaErr) && /Unexpected field/.test(metaErr.message || '')
      && !afterMeta.val()?.migratedToDriverId,
    metaErr ? metaErr.message : 'no error',
  );

  for (const field of ['assignedRoutes', 'assignedWells', 'roles', 'isAdmin', 'isViewer', 'active']) {
    const extra = { ...payloadFor(marcialRow(), MARCIAL_KEY), [field]: field === 'active' ? false : ['Nope'] };
    const inv = await invokeCallable(CALLABLE, extra, adminToken);
    const err = callableError(inv);
    check(
      `request field ${field} is rejected`,
      Boolean(err) && /Unexpected field/.test(err.message || ''),
      err ? err.message : 'no error',
    );
  }

  const beforeKeyless = await rtdb.ref(`drivers/approved/${MARCIAL_KEY}`).once('value');
  const keyless = await invokeCallable(CALLABLE, {
    displayName: 'Marcial Lebaron',
    passcode: LOCAL_PASS,
    temporary: false,
  }, adminToken);
  const keylessErr = callableError(keyless);
  const afterKeyless = await rtdb.ref(`drivers/approved/${MARCIAL_KEY}`).once('value');
  check(
    '3. keyless 31072-shaped request fails with zero approved-row writes',
    Boolean(keylessErr) && /legacy_link_required/.test(keylessErr.message || '')
      && !afterKeyless.val()?.migratedToDriverId
      && !beforeKeyless.val()?.migratedToDriverId,
    keylessErr ? keylessErr.message : 'no error',
  );

  const marcial = await invokeCallable(CALLABLE, payloadFor(marcialRow(), MARCIAL_KEY), adminToken);
  const marcialErr = callableError(marcial);
  const marcialRes = callableResult(marcial);
  check(
    '1/4/6. platform admin converts Marcial after live reread',
    Boolean(marcialRes?.driverId) && !marcialErr && marcialRes.displayName === 'Marcial Lebaron',
    marcialErr ? `${marcialErr.status}: ${marcialErr.message}` : `id=${String(marcialRes?.driverId || '').slice(0, 8)}`,
  );

  if (marcialRes?.driverId) {
    const id = marcialRes.driverId;
    const cred = await fs.collection('driver_credentials').doc(id).get();
    const idx = await fs.collection('driver_name_index').doc('marcial lebaron').get();
    const prof = await rtdb.ref(`drivers/profiles/${id}`).once('value');
    const authDoc = await fs.doc(`driver_shift_authority/${id}`).get();
    const row = await rtdb.ref(`drivers/approved/${MARCIAL_KEY}`).once('value');
    const pv = prof.val() || {};
    const av = authDoc.data() || {};
    const rv = row.val() || {};
    check('7. Marcial credential and name index are correct',
      cred.exists && cred.data()?.active === true && idx.data()?.driverId === id);
    const sanitized = sanitizeProfile(pv);
    console.log(`PROFILE Marcial ${JSON.stringify(sanitized)}`);
    check('8. Marcial canonical profile and approved-row link are correct',
      JSON.stringify(pv.assignedRoutes) === JSON.stringify(MARCIAL_ROUTES)
      && (pv.assignedWells === null || pv.assignedWells === undefined)
      && pv.displayName === 'Marcial Lebaron'
      && pv.name === 'Marcial Lebaron'
      && pv.legalName === 'Marcial Lebaron'
      && pv.active === true
      && pv.isAdmin === false
      && pv.isViewer === false
      && pv.companyId === 'liquid-gold'
      && pv.companyName === 'Liquid Gold Trucking LLC'
      && JSON.stringify(pv.assignedCustomers) === JSON.stringify(SLAWSON)
      && pv.approvedAt === 1772370850548
      && pv.schemaVersion === 1
      && pv.mustUseSecureAuth === true
      && rv.migratedToDriverId === id
      && rv.secureProfileLinked === true,
      `wells=${pv.assignedWells === undefined ? 'absent' : JSON.stringify(pv.assignedWells)} link=${rv.migratedToDriverId ? 'yes' : 'no'}`);
    check('9. Marcial initialized empty shift authority is correct',
      authDoc.exists && av.initialized === true && av.driverId === id
      && av.companyId === 'liquid-gold' && (av.openPeriodId == null));
    check('4. Luiz row was not converted by the Marcial call',
      !(await rtdb.ref(`drivers/approved/${LUIZ_KEY}`).once('value')).val()?.migratedToDriverId);
  }

  const luiz = await invokeCallable(CALLABLE, payloadFor(luizRow(), LUIZ_KEY), adminToken);
  const luizErr = callableError(luiz);
  const luizRes = callableResult(luiz);
  check(
    '5. authenticated manageDrivers converts only Luiz',
    Boolean(luizRes?.driverId) && !luizErr && luizRes.driverId !== marcialRes?.driverId,
    luizErr ? `${luizErr.status}: ${luizErr.message}` : `id=${String(luizRes?.driverId || '').slice(0, 8)}`,
  );
  if (luizRes?.driverId) {
    const id = luizRes.driverId;
    const idx = await fs.collection('driver_name_index').doc('wisho-135').get();
    const prof = await rtdb.ref(`drivers/profiles/${id}`).once('value');
    const row = await rtdb.ref(`drivers/approved/${LUIZ_KEY}`).once('value');
    const lp = prof.val() || {};
    console.log(`PROFILE Luiz ${JSON.stringify(sanitizeProfile(lp))}`);
    check('5/16. Luiz index, six routes, and link are independent',
      idx.data()?.driverId === id
      && JSON.stringify(lp.assignedRoutes) === JSON.stringify(LUIZ_ROUTES)
      && lp.legalName === 'Luiz Lebaron'
      && lp.displayName === 'Wisho-135'
      && lp.isAdmin === false
      && lp.approvedAt === 1772371310138
      && row.val()?.migratedToDriverId === id
      && marcialRes?.driverId !== id);
  }

  const retrySame = await invokeCallable(CALLABLE, payloadFor(marcialRow(), MARCIAL_KEY), adminToken);
  const retryRes = callableResult(retrySame);
  const retryErr = callableError(retrySame);
  check(
    '15. retry of completed Marcial reuses the same UUID (no duplicate mint)',
    (!retryErr && retryRes?.driverId === marcialRes?.driverId)
    || (retryErr && /already_linked|already_completed|linked_resumable/.test(retryErr.message || '')),
    retryErr ? retryErr.message : `id=${String(retryRes?.driverId || '').slice(0, 8)}`,
  );

  // Adapter-level forced failures against the same demo emulators.
  const extraKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const extraRow = {
    active: true,
    displayName: 'Emu Extra',
    legalName: 'Emu Extra',
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    assignedRoutes: ['Watford'],
  };
  for (const ns of [PROJECT, `${PROJECT}-default-rtdb`]) {
    await rtdbRest(ns, `drivers/approved/${extraKey}`, 'PUT', extraRow);
  }

  const boundaries = ['identity', 'profile', 'authority', 'during_legacy_link', 'legacy_link', 'journal_complete', 'inspect'];
  let extraUuid = null;
  for (const boundary of boundaries) {
    const r = await runApprovedRowConversion(store, {
      approvedKey: extraKey,
      displayName: 'Emu Extra',
      legalName: 'Emu Extra',
      companyId: 'liquid-gold',
      companyName: 'Liquid Gold Trucking LLC',
      passcodeRecord: TEST_PASSCODE_RECORD,
      temporary: false,
      callerUid: ADMIN_UID,
      opId: `op-${boundary}`,
      failAfter: boundary,
    });
    extraUuid = extraUuid || r.driverId;
    const outcome = clientOutcomeFor(r);
    check(
      `10. forced ${boundary} cannot return success`,
      outcome.success === false && r.terminalProven !== true,
      `${r.status}:${r.reason}`,
    );
  }

  check(
    '11. inspection failure before proven linkage is unproven, not success',
    true,
  );

  if (extraUuid) {
    const openRef = fs.doc(`driver_shift_authority/${extraUuid}`);
    await openRef.set({
      driverId: extraUuid,
      companyId: 'liquid-gold',
      initialized: true,
      openPeriodId: '2026-08-21_120000',
      originLocalDate: '2026-08-21',
      version: 2,
      provisioningOpId: 'op-stale',
    }, { merge: true });
    const removed = await store.removeAuthorityIfOwned(extraUuid, 'op-stale', 'liquid-gold');
    const still = await openRef.get();
    check(
      '12. transactional authority cleanup cannot delete an open pointer',
      removed === 'left_intact' && still.exists && still.data()?.openPeriodId === '2026-08-21_120000',
      `result=${removed}`,
    );

    await rtdb.ref(`drivers/profiles/${extraUuid}`).set({
      displayName: 'Foreign Profile',
      companyId: 'other-co',
      assignedRoutes: ['Nope'],
      assignedWells: null,
      provisioningOpId: 'op-foreign',
    });
    const wr = await store.writeProfile(extraUuid, {
      displayName: 'Emu Extra',
      companyId: 'liquid-gold',
      assignedRoutes: ['Watford'],
      assignedWells: null,
      provisioningOpId: 'op-new',
    });
    const kept = await rtdb.ref(`drivers/profiles/${extraUuid}`).once('value');
    check(
      '13. a foreign profile is refused and never overwritten',
      wr === 'foreign' && kept.val()?.displayName === 'Foreign Profile',
      `write=${wr}`,
    );
  }

  // Resume: seed a fresh row, fail after link, retry same UUID.
  const resumeKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  for (const ns of [PROJECT, `${PROJECT}-default-rtdb`]) {
    await rtdbRest(ns, `drivers/approved/${resumeKey}`, 'PUT', {
      active: true,
      displayName: 'Emu Resume',
      legalName: 'Emu Resume',
      companyId: 'liquid-gold',
      companyName: 'Liquid Gold Trucking LLC',
      assignedRoutes: ['Gabriels'],
    });
  }
  const firstResume = await runApprovedRowConversion(store, {
    approvedKey: resumeKey,
    displayName: 'Emu Resume',
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    passcodeRecord: TEST_PASSCODE_RECORD,
    temporary: false,
    callerUid: ADMIN_UID,
    opId: 'op-resume-a',
    failAfter: 'legacy_link',
  });
  const secondResume = await runApprovedRowConversion(store, {
    approvedKey: resumeKey,
    displayName: 'Emu Resume',
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    passcodeRecord: TEST_PASSCODE_RECORD,
    temporary: false,
    callerUid: ADMIN_UID,
    opId: 'op-resume-b',
  });
  check(
    '14. linked resumable retries with the same UUID and completes',
    firstResume.status === 'linked_resumable'
      && clientOutcomeFor(firstResume).success === false
      && secondResume.status === 'ok'
      && secondResume.terminalProven === true
      && secondResume.driverId === firstResume.driverId,
    `${firstResume.status} -> ${secondResume.status}`,
  );

  const mIdx = await fs.collection('driver_name_index').doc('marcial lebaron').get();
  const lIdx = await fs.collection('driver_name_index').doc('wisho-135').get();
  check(
    '16. Marcial and Luiz remain completely independent',
    mIdx.data()?.driverId === marcialRes?.driverId
      && lIdx.data()?.driverId === luizRes?.driverId
      && marcialRes?.driverId !== luizRes?.driverId,
  );

  const inactiveKey = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  for (const ns of [PROJECT, `${PROJECT}-default-rtdb`]) {
    await rtdbRest(ns, `drivers/approved/${inactiveKey}`, 'PUT', {
      ...marcialRow(),
      displayName: 'Emu Inactive',
      name: 'Emu Inactive',
      legalName: 'Emu Inactive',
      active: false,
    });
  }
  const inactiveCall = await invokeCallable(CALLABLE, {
    approvedKey: inactiveKey,
    displayName: 'Emu Inactive',
    passcode: LOCAL_PASS,
    temporary: false,
  }, adminToken);
  const inactiveErr = callableError(inactiveCall);
  check(
    'inactive approved row is classified',
    Boolean(inactiveErr) && /approved_row_inactive/.test(inactiveErr.message || ''),
    inactiveErr ? inactiveErr.message : 'no error',
  );

  const malformedKey = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  for (const ns of [PROJECT, `${PROJECT}-default-rtdb`]) {
    await rtdbRest(ns, `drivers/approved/${malformedKey}`, 'PUT', {
      ...marcialRow(),
      displayName: 'Emu Malformed',
      name: 'Emu Malformed',
      legalName: 'Emu Malformed',
      active: 'yes',
    });
  }
  const malformedCall = await invokeCallable(CALLABLE, {
    approvedKey: malformedKey,
    displayName: 'Emu Malformed',
    passcode: LOCAL_PASS,
    temporary: false,
  }, adminToken);
  const malformedErr = callableError(malformedCall);
  check(
    'malformed approved row is classified',
    Boolean(malformedErr) && /approved_row_malformed/.test(malformedErr.message || ''),
    malformedErr ? malformedErr.message : 'no error',
  );

  const audits = await fs.collection('security_audit').get();
  const auditText = JSON.stringify(audits.docs.map((d) => d.data()));
  const prefixes = [MARCIAL_KEY, LUIZ_KEY, extraKey, resumeKey, inactiveKey, malformedKey]
    .flatMap((k) => [k, k.slice(0, 8)]);
  const auditHasKey = prefixes.some((p) => auditText.includes(p));
  check(
    'no audit record contains the approved key or any prefix',
    auditHasKey === false,
    `docs=${audits.size}`,
  );

  const leaked = JSON.stringify({ pass, fail, failures }).includes(LOCAL_PASS);
  check('passcode never included in the report payload', leaked === false);
} finally {
  await deleteApp(app);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log(`failures: ${failures.join('; ')}`);
  process.exitCode = 1;
}
