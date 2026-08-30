// Real-callable INGEST REFUSAL harness (completion audit item 4 — matrix
// cases 'ingest-structured-permanent-refusal' and 'transient-ingest-retry').
//
// Drives the REAL exported ingestWbmPull callable over HTTP against the
// Functions + Auth + Firestore + Database emulators: a seeded secure driver
// (auth-emulator user with driver claims, RTDB profile, Firestore
// credentials) submits malformed / out-of-scope / valid pulls. Asserts the
// stable reason codes, the transient-vs-permanent classes the client parks
// on, that refusals leave NO RTDB material and NO revision signal, and that
// a retry after a transient (unauthenticated) failure succeeds with the SAME
// packet id.
//
// RUN:
//   JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=C:\t' GCLOUD_PROJECT=wellbuilt-sync \
//   npx firebase emulators:exec --config firebase.emulator.json \
//     --only functions,database,firestore,auth --project wellbuilt-sync \
//     "node functions/emulator/ingest.mjs"

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: PROJECT_ID,
  databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb`,
});

const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
const FN = `http://127.0.0.1:5003/${PROJECT_ID}/us-central1/ingestWbmPull`;

let failures = 0;
const results = [];
const check = (name, cond, detail = '') => {
  if (cond) results.push(`  PASS  ${name}`);
  else { failures++; results.push(`  FAIL  ${name}  ${detail}`); }
};

const DRIVER_ID = 'emu-driver-1';
const WELL = 'Gabriel 1';
const PID = '20260827_100000_Gabriel1_abc123';

async function callIngest(packet, idToken, clientMeta) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ data: clientMeta ? { packet, clientMeta } : { packet } }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  await db.ref('/').set(null);
  await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'Gabriels', companyId: 'liquid-gold' });
  await db.ref(`drivers/profiles/${DRIVER_ID}`).set({
    active: true, companyId: 'liquid-gold', displayName: 'Emu Driver',
    assignedRoutes: ['Gabriels'], assignedWells: [],
  });
  await admin.firestore().collection('driver_credentials').doc(DRIVER_ID).set({ active: true });
  await db.ref('packets/incoming_version').set(5000);

  // Seed the secure driver in the AUTH EMULATOR and mint an ID token.
  const uid = `driver_${DRIVER_ID}`;
  await admin.auth().createUser({ uid });
  await admin.auth().setCustomUserClaims(uid, { kind: 'driver', driverId: DRIVER_ID, companyId: 'liquid-gold', roles: ['driver'] });
  const custom = await admin.auth().createCustomToken(uid);
  const signIn = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const { idToken } = await signIn.json();
  check('auth emulator issued a driver ID token', !!idToken, 'no token');

  const basePull = {
    requestType: 'pull', wellName: WELL,
    dateTimeUTC: '2026-08-27T15:00:00.000Z', dateTime: '8/27/2026 10:00 AM',
    tankLevelFeet: 9, bblsTaken: 40, packetId: PID, idempotencyKey: PID,
  };

  // ── TRANSIENT: unauthenticated → 401 UNAUTHENTICATED — retryable class ──
  const unauth = await callIngest(basePull, undefined);
  check('unauthenticated ingest → HTTP 401 UNAUTHENTICATED (transient class: retry later)', unauth.status === 401 && unauth.body?.error?.status === 'UNAUTHENTICATED', JSON.stringify([unauth.status, unauth.body?.error?.status]));
  check('transient refusal leaves NO RTDB material', (await db.ref('packets/incoming').once('value')).val() === null && (await db.ref('packets/processed').once('value')).val() === null, 'no material');
  check('transient refusal signals NO revision', (await db.ref('packets/incoming_version').once('value')).val() === 5000, 'no bump');

  // ── PERMANENT: malformed packet → 400 INVALID_ARGUMENT + stable reason ──
  const malformed = await callIngest({ ...basePull, dateTimeUTC: 'not-a-time' }, idToken);
  check('malformed packet → 400 INVALID_ARGUMENT with the STABLE reason', malformed.status === 400 && malformed.body?.error?.status === 'INVALID_ARGUMENT' && malformed.body?.error?.message === 'invalid_dateTimeUTC', JSON.stringify([malformed.status, malformed.body?.error?.status, malformed.body?.error?.message]));

  // ── PERMANENT: out-of-scope well → 400 FAILED_PRECONDITION ──
  await db.ref(`well_config/Watford 9`).set({ tanks: 1, bblPerFoot: 20, route: 'Watford', companyId: 'liquid-gold' });
  const oosId = '20260827_100000_Watford9_abc123';
  const oos = await callIngest({ ...basePull, wellName: 'Watford 9', packetId: oosId, idempotencyKey: oosId }, idToken);
  check('out-of-scope well → 400 FAILED_PRECONDITION well_out_of_scope', oos.status === 400 && oos.body?.error?.status === 'FAILED_PRECONDITION' && oos.body?.error?.message === 'well_out_of_scope', JSON.stringify([oos.status, oos.body?.error?.status, oos.body?.error?.message]));
  check('permanent refusals leave NO RTDB material and NO revision signal', (await db.ref('packets/incoming').once('value')).val() === null && (await db.ref('packets/incoming_version').once('value')).val() === 5000, 'clean');

  // ── TRANSIENT RETRY: the SAME packet that failed unauthenticated succeeds
  //    once authenticated — same id, no duplicate, full commit downstream. ──
  const ok = await callIngest(basePull, idToken, { appVersion: '2.1.0', versionCode: '26', platform: 'android', imei: 'should-be-dropped' });
  check('valid pull with clientMeta envelope → accepted, SAME packet id honored', ok.status === 200 && ok.body?.result?.ok === true && ok.body?.result?.packetId === PID, JSON.stringify([ok.status, ok.body?.result]));
  // The real trigger consumes it and commits canonically.
  let processed = null;
  for (let i = 0; i < 40 && !processed; i++) { await new Promise((r) => setTimeout(r, 500)); processed = (await db.ref(`packets/processed/${PID}`).once('value')).val(); }
  check('transient-then-retry pull committed end-to-end (processed row exists)', !!processed, 'no processed row');
  check('commit carried BOTH revision signals', (await db.ref('packets/incoming_version').once('value')).val() === 5000 + 1048576 && ((await db.ref('packets/incoming_revision_v2').once('value')).val() || {}).token === PID, 'revisions');

  // ── Idempotent callable replay: same envelope again → duplicate:true, no new bump ──
  const replay = await callIngest(basePull, idToken);
  check('callable replay → duplicate:true (or idempotent re-accept), no second commit signal',
    replay.status === 200 && (await db.ref('packets/incoming_version').once('value')).val() === 5000 + 1048576,
    JSON.stringify([replay.status, replay.body?.result]));

  console.log('\n=== INGEST REFUSAL RESULTS (real callable over HTTP, real auth emulator) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[ingest] fatal', e); process.exit(2); });
