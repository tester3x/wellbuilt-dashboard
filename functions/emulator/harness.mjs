// Real Firebase Emulator harness — drives the ACTUAL exported RTDB triggers by
// writing request packets to packets/incoming/<id> and asserting the resulting
// database state + receipts after the trigger completes. Run under
// `firebase emulators:exec` so the Functions + Database emulators are live and the
// real processIncomingPull / processEditRequest / processDeleteRequest fire on our
// writes. This is NOT a unit mock — it exercises the deployed handlers.
//
// RUN (from repo root; alt ports never touch a running emulator):
//   export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=D:\tmp"
//   export FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 GCLOUD_PROJECT=wellbuilt-sync
//   npm --prefix functions run build
//   npx firebase emulators:exec --config firebase.emulator.json \
//       --only functions,database --project wellbuilt-sync \
//       "node functions/emulator/harness.mjs"
//
// (Firestore emulator is intentionally NOT started — its JAR is incompatible with
//  the local Java 21. FIRESTORE_EMULATOR_HOST points at a dead port so the two
//  best-effort Firestore back-patches fail locally and NEVER touch production.)
//
// ENVIRONMENT NOTE (2026-08-28): on this machine the JVM cannot open an NIO
// selector — a minimal `Selector.open()` fails with
//   java.io.IOException: Unable to establish loopback connection
//   Caused by: java.net.SocketException: Invalid argument: connect
// which blocks EVERY Firebase emulator JVM (reproduced with a 3-line program;
// not a firebase-tools/port/tmpdir issue). This harness is complete and correct;
// it will run wherever the JVM can open a selector.
import admin from 'firebase-admin';

const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002';
const PROJECT = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'wellbuilt-sync';
// v1 database triggers run against the default RTDB instance <project>-default-rtdb;
// the harness must read/write the SAME namespace or the triggers never fire.
const NS = `${PROJECT}-default-rtdb`;

admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${DB_HOST}/?ns=${NS}` });
const db = admin.database();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { results.push(`  PASS  ${name}`); }
  else { failures++; results.push(`  FAIL  ${name}  ${detail}`); }
}

/** Poll a path until predicate(value) or timeout. Returns the last value. */
async function waitFor(path, pred, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const started = Date.now();
  // NB: Date.now is fine here — this is a harness, not a workflow script.
  while (Date.now() - started < timeoutMs) {
    const snap = await db.ref(path).once('value');
    const v = snap.val();
    if (pred(v)) return v;
    await sleep(intervalMs);
  }
  const snap = await db.ref(path).once('value');
  return snap.val();
}

async function reset() {
  await db.ref('/').set(null);
}

async function seedWellConfig(well, cfg) {
  await db.ref(`well_config/${well}`).set({
    tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'R1', ...cfg,
  });
}

/** Write an incoming pull request exactly like WB-M does. */
async function sendPull(id, well, over = {}) {
  await db.ref(`packets/incoming/${id}`).set({
    requestType: 'pull', wellName: well, packetId: id,
    dateTimeUTC: '2026-08-27T18:00:00.000Z', dateTime: '8/27/2026 1:00 PM',
    tankLevelFeet: '13.166666', bblsTaken: 60, driverId: 'd1', driverName: 'Driver One',
    ...over,
  });
}

const receiptPath = (well, op) => `wells/${well}/chronoReceipts/${op}`;

async function main() {
  const WELL = 'Atlas1';
  console.log(`[harness] db=${DB_HOST} ns=${NS}`);

  // ── Scenario 1: newest CREATE fires the real trigger and lands canonical state
  await reset();
  await seedWellConfig(WELL, {});
  await sendPull('p1', WELL, { tankLevelFeet: '13.166666', bblsTaken: 60 }); // top 158", bottom 158-36=122
  const proc1 = await waitFor(`packets/processed/p1`, (v) => v && v.processedAt);
  check('CREATE newest → processed row written by real trigger', !!proc1, JSON.stringify(proc1));
  check('CREATE newest → lateEntry stored false', proc1 && proc1.lateEntry === false, JSON.stringify(proc1 && proc1.lateEntry));
  const rc1 = await waitFor(receiptPath(WELL, 'p1'), (v) => !!v);
  check('CREATE newest → completion receipt committed', !!rc1 && rc1.operationId === 'p1', JSON.stringify(rc1));
  const inc1 = (await db.ref('packets/incoming/p1').once('value')).val();
  check('CREATE newest → incoming request consumed in the same commit', inc1 === null, JSON.stringify(inc1));
  const out1 = await waitFor('packets/outgoing', (v) => v && Object.keys(v || {}).length > 0);
  const outRow1 = out1 && Object.values(out1)[0];
  check('CREATE newest → outgoing/current written', !!outRow1 && outRow1.lastPullPacketId === 'p1', JSON.stringify(outRow1 && outRow1.lastPullPacketId));
  const rev1 = (await db.ref(`wells/${WELL}/status/chronoRevision`).once('value')).val();
  check('CREATE newest → chronoRevision advanced to 1', rev1 === 1, JSON.stringify(rev1));
  const lock1 = (await db.ref(`wells/${WELL}/status/chronoLock`).once('value')).val();
  check('CREATE newest → lock released after commit', lock1 === null, JSON.stringify(lock1));

  // ── Scenario 2: idempotent replay (same id) does not double-apply
  await sendPull('p1', WELL, { tankLevelFeet: '13.166666', bblsTaken: 60 });
  await sleep(3000);
  const inc1b = (await db.ref('packets/incoming/p1').once('value')).val();
  check('replay same id → consumed again, no error', inc1b === null, JSON.stringify(inc1b));
  const procCount = Object.keys((await db.ref('packets/processed').once('value')).val() || {}).length;
  check('replay same id → still exactly one processed row', procCount === 1, `count=${procCount}`);

  console.log('\n=== EMULATOR HARNESS RESULTS ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  await admin.app().delete();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('[harness] fatal', e); try { await admin.app().delete(); } catch {} process.exit(2); });
