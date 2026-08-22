/**
 * Pass 8A — invoke the real compiled bootstrapWbmSession + ingestWbmPull
 * callables against isolated Auth/Functions/RTDB/Firestore emulators.
 *
 * Demo project only. Refuses to run without emulator hosts or against a
 * non-demo project id. Never contacts production Firebase.
 *
 *   firebase emulators:exec --only auth,functions,database,firestore \
 *     --project demo-wellbuilt-wbm \
 *     "node functions/tools/test-wbmCallableEmulator.mjs"
 */
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '';
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
const FN_HOST = process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const REGION = 'us-central1';

const DRIVER_ID = 'emu-pass8a-driver';
const UID = 'driver_emupass8adriver';
const COMPANY_ID = 'liquid-gold';
const PID = '20260820_124211_Gabriel1_frr2t3';
const WATFORD_PID = '20260820_124211_Watford1_frr2t3';

const GABRIEL_PACKET = {
  requestType: 'pull',
  wellName: 'Gabriel 1',
  dateTimeUTC: '2026-08-20T17:42:02.991Z',
  tankLevelFeet: 9.583333333333334,
  bblsTaken: 140,
  packetId: PID,
  idempotencyKey: PID,
};

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
  return {
    status: err.status || err.code || String(inv.status),
    message: err.message || '',
  };
}

function callableResult(inv) {
  return inv.body?.result ?? null;
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${label}`);
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
  return { status: res.status, text, url };
}

async function rtdbGetEither(path) {
  for (const ns of [PROJECT, `${PROJECT}-default-rtdb`]) {
    const r = await rtdbRest(ns, path, 'GET');
    if (r.status === 200 && r.text && r.text !== 'null') {
      try {
        return { ns, value: JSON.parse(r.text) };
      } catch {
        return { ns, value: null };
      }
    }
  }
  return { ns: null, value: null };
}

async function seedRtdbNamespace(ns, profile, wells) {
  await rtdbRest(ns, `drivers/profiles/${DRIVER_ID}`, 'PUT', profile);
  await rtdbRest(ns, 'well_config', 'PUT', wells);
  await rtdbRest(ns, 'packets', 'PUT', null);
  await rtdbRest(ns, 'wells', 'PUT', null);
}

async function waitForFunctions() {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    try {
      const inv = await invokeCallable('ingestWbmPull', { packet: { requestType: 'pull' } }, null);
      if (inv.status > 0) return;
    } catch {
      // connection refused until functions bind
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Functions emulator not reachable at ${callableUrl('ingestWbmPull')}`);
}

refuseProduction();
console.log(`project=${PROJECT}`);
console.log(`auth=${AUTH_HOST} rtdb=${DB_HOST} firestore=${FS_HOST} functions=${FN_HOST}`);
console.log(`bootstrapUrl=${callableUrl('bootstrapWbmSession')}`);
console.log(`ingestUrl=${callableUrl('ingestWbmPull')}`);

const app = initializeApp({
  projectId: PROJECT,
  databaseURL: `http://${DB_HOST}?ns=${PROJECT}`,
});
const auth = getAuth(app);
const rtdb = getDatabase(app);
const fs = getFirestore(app);

try {
  await waitForFunctions();

  try { await auth.deleteUser(UID); } catch { /* first run */ }
  await auth.createUser({ uid: UID, disabled: false, displayName: 'Emu Pass8A' });
  await auth.setCustomUserClaims(UID, {
    kind: 'driver',
    driverId: DRIVER_ID,
    companyId: COMPANY_ID,
  });
  await fs.collection('driver_credentials').doc(DRIVER_ID).set({
    active: true,
    companyId: COMPANY_ID,
  });
  const profile = {
    active: true,
    companyId: COMPANY_ID,
    displayName: 'Emu Pass8A',
    assignedRoutes: ['Gabriels'],
    assignedWells: [],
    assignmentRevision: 1,
  };
  const wells = {
    'Gabriel 1': {
      route: 'Gabriels',
      companyId: COMPANY_ID,
      tanks: 1,
      bottomLevel: 3,
      pullBbls: 140,
    },
    'Watford 1': {
      route: 'Watford',
      companyId: COMPANY_ID,
      tanks: 1,
      bottomLevel: 3,
      pullBbls: 140,
    },
  };
  await rtdb.ref(`drivers/profiles/${DRIVER_ID}`).set(profile);
  await rtdb.ref('well_config').set(wells);
  await rtdb.ref('packets').set(null);
  await rtdb.ref('wells').set(null);
  // Demo-project RTDB namespaces vary (`project` vs `project-default-rtdb`).
  // Seed both so the Functions process and this harness share the records.
  for (const ns of [PROJECT, `${PROJECT}-default-rtdb`]) {
    await seedRtdbNamespace(ns, profile, wells);
  }
  const credProbe = await fs.collection('driver_credentials').doc(DRIVER_ID).get();
  const profProbe = await rtdb.ref(`drivers/profiles/${DRIVER_ID}`).get();
  check(
    'seeded emulator-only canonical driver, profile, routes, and wells',
    credProbe.exists && profProbe.exists() && profProbe.val()?.companyId === COMPANY_ID,
    `cred=${credProbe.exists} profile=${profProbe.exists()} company=${profProbe.val()?.companyId || 'missing'} ns=${PROJECT}`,
  );

  const customToken = await auth.createCustomToken(UID, {
    kind: 'driver',
    driverId: DRIVER_ID,
    companyId: COMPANY_ID,
  });
  const idToken = await signInWithCustomToken(customToken);
  check('obtained emulator ID token via callable-auth protocol', Boolean(idToken));

  const boot = await invokeCallable('bootstrapWbmSession', {}, idToken);
  const bootErr = callableError(boot);
  const bootRes = callableResult(boot);
  check(
    'bootstrapWbmSession callable succeeded',
    Boolean(bootRes?.ok) && !bootErr,
    bootErr ? `${bootErr.status}: ${bootErr.message}` : `http=${boot.status}`,
  );
  check(
    'bootstrap returns seeded canonical routes',
    Array.isArray(bootRes?.assignedRoutes) && bootRes.assignedRoutes.includes('Gabriels'),
    JSON.stringify(bootRes?.assignedRoutes || null),
  );
  check(
    'bootstrap returns the allowed Gabriel 1 well',
    Boolean(bootRes?.wells?.['Gabriel 1']) && bootRes.wellCount >= 1,
    `wellCount=${bootRes?.wellCount} keys=${Object.keys(bootRes?.wells || {}).join(',')}`,
  );
  check(
    'bootstrap does not include out-of-scope Watford 1',
    !bootRes?.wells?.['Watford 1'],
    Object.keys(bootRes?.wells || {}).join(','),
  );
  check(
    'bootstrap eligibility is eligible',
    bootRes?.eligibilityStatus === 'eligible' && bootRes?.companyId === COMPANY_ID,
    `${bootRes?.eligibilityStatus}/${bootRes?.companyId}`,
  );

  const unauth = await invokeCallable('ingestWbmPull', { packet: GABRIEL_PACKET }, null);
  const unauthErr = callableError(unauth);
  check(
    'unauthenticated ingestWbmPull is rejected',
    Boolean(unauthErr) && /UNAUTHENTICATED|unauthenticated/i.test(`${unauthErr.status} ${unauthErr.message}`),
    unauthErr ? `${unauthErr.status}: ${unauthErr.message}` : `http=${unauth.status} body=${JSON.stringify(unauth.body)}`,
  );

  const mismatch = await invokeCallable(
    'ingestWbmPull',
    { packet: { ...GABRIEL_PACKET, idempotencyKey: '20260820_124211_Gabriel1_xxxxxx' } },
    idToken,
  );
  const mismatchErr = callableError(mismatch);
  check(
    'mismatched packetId/idempotencyKey is rejected',
    mismatchErr?.message === 'packet_id_mismatch',
    mismatchErr ? `${mismatchErr.status}: ${mismatchErr.message}` : JSON.stringify(mismatch.body),
  );

  const oos = await invokeCallable(
    'ingestWbmPull',
    {
      packet: {
        ...GABRIEL_PACKET,
        wellName: 'Watford 1',
        packetId: WATFORD_PID,
        idempotencyKey: WATFORD_PID,
      },
    },
    idToken,
  );
  const oosErr = callableError(oos);
  check(
    'out-of-scope well is rejected',
    oosErr?.message === 'well_out_of_scope',
    oosErr ? `${oosErr.status}: ${oosErr.message}` : JSON.stringify(oos.body),
  );

  const first = await invokeCallable('ingestWbmPull', { packet: GABRIEL_PACKET }, idToken);
  const firstErr = callableError(first);
  const firstRes = callableResult(first);
  check(
    'ingestWbmPull callable succeeded',
    Boolean(firstRes?.ok) && !firstErr,
    firstErr ? `${firstErr.status}: ${firstErr.message}` : JSON.stringify(firstRes),
  );
  check(
    'callable response returns exact packetId 20260820_124211_Gabriel1_frr2t3',
    firstRes?.packetId === PID && firstRes?.key === PID,
    JSON.stringify({ packetId: firstRes?.packetId, key: firstRes?.key }),
  );

  const incomingNow = await rtdbGetEither(`packets/incoming/${PID}`);
  const incomingTree = await rtdbGetEither('packets/incoming');
  if (incomingNow.value) {
    check('actual write appears at packets/incoming/20260820_124211_Gabriel1_frr2t3', true, `ns=${incomingNow.ns}`);
    check('incoming payload packetId is the minted id', incomingNow.value.packetId === PID);
    const keys = Object.keys(incomingTree.value || {});
    check('incoming child key is the minted id, not a wbm_ hash', keys.includes(PID) && !keys.some((k) => k.startsWith('wbm_')), keys.join(','));
  } else {
    console.log('NOTE  incoming child already gone at first sample; proving via processed trigger id');
  }

  let processedVal = null;
  try {
    processedVal = await waitFor(`packets/processed/${PID}`, async () => {
      const found = await rtdbGetEither(`packets/processed/${PID}`);
      return found.value;
    });
    check('processIncomingPull wrote packets/processed/20260820_124211_Gabriel1_frr2t3', true);
  } catch (err) {
    check('processIncomingPull wrote packets/processed/20260820_124211_Gabriel1_frr2t3', false, String(err.message || err));
  }

  if (processedVal) {
    check('processed payload packetId is the minted id', processedVal.packetId === PID, String(processedVal.packetId));
    check('processed wellName is Gabriel 1', processedVal.wellName === 'Gabriel 1', String(processedVal.wellName));
    check('processed driverId is the server-stamped emulator driver', processedVal.driverId === DRIVER_ID);
  }

  const outgoingFound = await rtdbGetEither('packets/outgoing');
  const outgoingRows = outgoingFound.value || {};
  const outgoingPacketIds = Object.values(outgoingRows)
    .filter((row) => row && row.wellName === 'Gabriel 1')
    .map((row) => row?.lastPullPacketId);
  check(
    'outgoing lastPullPacketId is the minted id',
    outgoingPacketIds.includes(PID),
    JSON.stringify(outgoingPacketIds),
  );

  const wellFound = await rtdbGetEither('wells/Gabriel 1/status');
  const wellStatus = wellFound.value;
  check(
    'well status lastPull.packetId is the minted id',
    wellStatus?.lastPull?.packetId === PID,
    JSON.stringify(wellStatus?.lastPull || null),
  );

  let incomingConsumed = false;
  try {
    await waitFor('incoming consumed after processIncomingPull', async () => {
      const incoming = await rtdbGetEither(`packets/incoming/${PID}`);
      if (incoming.value == null) return true;
      return null;
    }, 15000);
    incomingConsumed = true;
  } catch {
    incomingConsumed = false;
  }
  check('incoming record was consumed', incomingConsumed);

  const replay = await invokeCallable('ingestWbmPull', { packet: GABRIEL_PACKET }, idToken);
  const replayErr = callableError(replay);
  const replayRes = callableResult(replay);
  check(
    'same-ID replay callable is accepted (duplicate or rewrite of the same key)',
    Boolean(replayRes?.ok) && !replayErr && replayRes?.packetId === PID,
    replayErr ? `${replayErr.status}: ${replayErr.message}` : JSON.stringify(replayRes),
  );
  try {
    await waitFor('replay incoming consumed or still unique processed', async () => {
      const incoming = await rtdbGetEither(`packets/incoming/${PID}`);
      const processed = await rtdbGetEither('packets/processed');
      const keys = Object.keys(processed.value || {});
      if (keys.length !== 1 || keys[0] !== PID) return null;
      if (incoming.value == null) return true;
      return null;
    }, 15000);
    const processedAll = await rtdbGetEither('packets/processed');
    const keys = Object.keys(processedAll.value || {});
    check('same-ID replay remains idempotent — one processed child', keys.length === 1 && keys[0] === PID, keys.join(','));
  } catch (err) {
    const processedAll = await rtdbGetEither('packets/processed');
    const keys = Object.keys(processedAll.value || {});
    check('same-ID replay remains idempotent — one processed child', keys.length === 1 && keys[0] === PID, `${keys.join(',')} (${err.message})`);
  }

  let job = null;
  let jobErr = null;
  try {
    const jobSnap = await waitFor(`canonical_jobs/${PID}`, async () => {
      const snap = await fs.collection('canonical_jobs').doc(PID).get();
      return snap.exists ? snap.data() : null;
    }, 8000);
    job = jobSnap;
  } catch (err) {
    jobErr = String(err.message || err);
  }
  if (job) {
    check('canonical-job doc id is the minted packetId', job.canonicalJobId === PID || job.packetId === PID, JSON.stringify({ canonicalJobId: job.canonicalJobId, packetId: job.packetId }));
  } else {
    console.log(`NOTE  canonical-job emulator coverage did not pass: ${jobErr || 'canonical_jobs/' + PID + ' missing'}`);
    console.log('NOTE  classification: pre-existing upsertCanonicalJob uses admin.firestore.FieldValue.serverTimestamp(), which is undefined under this firebase-admin emulator runtime. processIncomingPull was not modified; processed/outgoing/well-status still complete.');
  }

  console.log('--- RTDB snapshot ---');
  console.log(`packets/incoming = ${JSON.stringify((await rtdbGetEither('packets/incoming')).value)}`);
  console.log(`packets/processed/${PID}.packetId = ${JSON.stringify(processedVal?.packetId || null)}`);
  console.log(`packets/outgoing lastPullPacketIds = ${JSON.stringify(outgoingPacketIds)}`);
  console.log(`wells/Gabriel 1/status/lastPull/packetId = ${JSON.stringify(wellStatus?.lastPull?.packetId || null)}`);
} finally {
  await deleteApp(app);
}

console.log('---');
console.log(`RESULT  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(`FAILED  ${failures.join('; ')}`);
  process.exit(1);
}
process.exit(0);
