// Equal-time CREATE arrival-order determinism (Thor 1 final proof #4). Two pulls
// at the SAME event-time must BOTH persist, and the canonical current must be
// selected by the deterministic packetId tie-break (highest id wins) — the SAME
// result regardless of which physically arrived/processed first. Drives the REAL
// processIncomingPull trigger by writing packets/incoming/<id>.
//
// RUN: node functions/emulator/run.mjs equalorder
import admin from 'firebase-admin';

const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002';
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const NS = `${PROJECT}-default-rtdb`;
admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${DB_HOST}/?ns=${NS}` });
const db = admin.database();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const results = [];
const check = (name, cond, detail = '') => { if (cond) results.push(`  PASS  ${name}`); else { failures++; results.push(`  FAIL  ${name}  ${detail}`); } };
async function waitFor(path, pred, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) { const v = (await db.ref(path).once('value')).val(); if (pred(v)) return v; await sleep(intervalMs); }
  return (await db.ref(path).once('value')).val();
}
async function seedWellConfig(well) { await db.ref(`well_config/${well}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'R1' }); }
async function sendPull(id, well, over = {}) {
  await db.ref(`packets/incoming/${id}`).set({ requestType: 'pull', wellName: well, packetId: id, dateTimeUTC: '2026-08-27T18:00:00.000Z', dateTime: '8/27/2026 1:00 PM', tankLevelFeet: '13.166666', bblsTaken: 60, driverId: 'd1', driverName: 'Driver One', ...over });
}
async function currentIdFor(well) {
  const all = (await db.ref('packets/outgoing').once('value')).val() || {};
  const row = Object.values(all).find((r) => r && r.wellName === well);
  return row ? row.lastPullPacketId : null;
}

// TEQ: identical event-time for both pulls in a well. Highest packetId must win.
const TEQ = '2026-08-27T18:00:00.000Z';

async function runOrder(well, firstId, secondId, expectedCurrent) {
  await seedWellConfig(well);
  await sendPull(firstId, well, { dateTimeUTC: TEQ });          // arrives/processes FIRST
  await waitFor(`packets/processed/${firstId}`, (v) => v && v.processedAt);
  await sendPull(secondId, well, { dateTimeUTC: TEQ });         // arrives/processes SECOND
  await waitFor(`packets/processed/${secondId}`, (v) => v && v.processedAt);
  await sleep(2500);
  const a = (await db.ref(`packets/processed/${firstId}`).once('value')).val();
  const b = (await db.ref(`packets/processed/${secondId}`).once('value')).val();
  const cur = await currentIdFor(well);
  check(`[${well}] arrival ${firstId}→${secondId}: BOTH pulls persist (neither dropped)`, !!a && !!b, `a=${!!a} b=${!!b}`);
  check(`[${well}] arrival ${firstId}→${secondId}: canonical current = ${expectedCurrent} (packetId tie-break, not arrival)`, cur === expectedCurrent, `current=${cur}`);
  return cur;
}

async function main() {
  await db.ref('/').set(null);
  console.log(`[equalorder] db=${DB_HOST} ns=${NS}`);
  // Canonical tie-break = event-time asc, then packetId ASC → the LEXICALLY-HIGHER
  // packetId is the canonical-newest/current. Ids chosen so the intended winner
  // (…_p2) is unambiguously the higher STRING (p2 > p1), avoiding hi/lo confusion.
  // Order A: p1 first, p2 second (lower id arrives first).
  const curA = await runOrder('EqOrdA', 'eq_A_p1', 'eq_A_p2', 'eq_A_p2');
  // Order B: p2 first, p1 second (higher id arrives first — reverse arrival).
  const curB = await runOrder('EqOrdB', 'eq_B_p2', 'eq_B_p1', 'eq_B_p2');
  // The canonical winner is the HIGHER packetId in BOTH orders — arrival-independent.
  check('tie-break is arrival-INDEPENDENT: higher packetId is current in both orders',
    curA === 'eq_A_p2' && curB === 'eq_B_p2', `A=${curA} B=${curB}`);

  console.log('\n=== EQUAL-TIME ARRIVAL-ORDER DETERMINISM (real processIncomingPull) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[equalorder] fatal', e); process.exit(2); });
