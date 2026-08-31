// Equal-time CREATE arrival-order determinism + provenance semantics (Thor 1).
// Two pulls at the SAME event-time must BOTH persist, and the canonical current
// must be selected by the deterministic packetId tie-break (HIGHER id is current)
// — the SAME result regardless of which physically arrived/processed first.
//
// `lateEntry` is DEFINED as ARRIVAL PROVENANCE: "this packet arrived after a
// canonical successor already existed", NOT "this packet is chronologically
// behind a successor." So for two equal-time pulls the SAME lower-id packet is
// lateEntry=false when it arrived FIRST (no successor existed yet) and
// lateEntry=true when it arrived SECOND (the higher-id current already existed).
// The current pointer and all MATERIAL canonical state are identical between the
// two arrival orders; only this provenance flag differs, and it is an
// informational review signal that gates no formula, billing, production,
// current-status, or mutation-eligibility decision.
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

// Fixed material per LOGICAL pull (attached to identity, not arrival slot):
const MAT = { p1: { tankLevelFeet: '13.0', bblsTaken: 60 }, p2: { tankLevelFeet: '12.5', bblsTaken: 55 } };
async function runOrder(well, lowerId, higherId, arrivalOrder /* [id,id] */, expectedCurrent) {
  await seedWellConfig(well);
  const matFor = (id) => (id === lowerId ? MAT.p1 : MAT.p2); // identity → material, regardless of arrival
  for (const id of arrivalOrder) {
    await sendPull(id, well, { dateTimeUTC: TEQ, ...matFor(id) });
    await waitFor(`packets/processed/${id}`, (v) => v && v.processedAt);
  }
  await sleep(2500);
  const lower = (await db.ref(`packets/processed/${lowerId}`).once('value')).val();
  const higher = (await db.ref(`packets/processed/${higherId}`).once('value')).val();
  const cur = await currentIdFor(well);
  check(`[${well}] arrival ${arrivalOrder.join('→')}: BOTH pulls persist (neither dropped)`, !!lower && !!higher, `lo=${!!lower} hi=${!!higher}`);
  check(`[${well}] arrival ${arrivalOrder.join('→')}: canonical current = ${expectedCurrent} (packetId tie-break, not arrival)`, cur === expectedCurrent, `current=${cur}`);
  return { cur, lower, higher };
}

async function main() {
  await db.ref('/').set(null);
  console.log(`[equalorder] db=${DB_HOST} ns=${NS}`);
  // Canonical tie-break = event-time asc, then packetId ASC → the LEXICALLY-HIGHER
  // packetId is the canonical-newest/current. Ids chosen so the winner (…_p2) is
  // unambiguously the higher STRING (p2 > p1). Both orders use the same well-local
  // p1/p2 material so material state is comparable across orders.
  // Order A: p1 (lower) arrives FIRST, then p2 (higher).
  const A = await runOrder('EqOrdA', 'eq_A_p1', 'eq_A_p2', ['eq_A_p1', 'eq_A_p2'], 'eq_A_p2');
  // Order B: p2 (higher) arrives FIRST, then p1 (lower) — reverse arrival.
  const B = await runOrder('EqOrdB', 'eq_B_p1', 'eq_B_p2', ['eq_B_p2', 'eq_B_p1'], 'eq_B_p2');
  // The canonical winner is the HIGHER packetId in BOTH orders — arrival-independent.
  check('tie-break is arrival-INDEPENDENT: higher packetId is current in both orders',
    A.cur === 'eq_A_p2' && B.cur === 'eq_B_p2', `A=${A.cur} B=${B.cur}`);

  // ── Provenance semantics: lateEntry = ARRIVAL provenance (not chronology) ──
  check('provenance: lower-id-FIRST is NOT labeled late (arrived before any successor existed)', A.lower.lateEntry === false, `lateEntry=${A.lower.lateEntry}`);
  check('provenance: lower-id-SECOND IS labeled late (arrived after the higher-id current existed)', B.lower.lateEntry === true, `lateEntry=${B.lower.lateEntry}`);

  // ── Material canonical state is IDENTICAL between the two arrival orders ──
  // Material is attached to identity (p1/p2), so the SAME logical pull is compared
  // across orders; only lateEntry differs.
  const matFields = (p) => ({ tankTopInches: p.tankTopInches, tankAfterInches: p.tankAfterInches, bblsTaken: p.bblsTaken, dateTimeUTC: p.dateTimeUTC, flowRateDays: p.flowRateDays, wellDown: p.wellDown ?? false });
  check('material: the CURRENT (higher-id p2) pull is materially identical across both orders', JSON.stringify(matFields(A.higher)) === JSON.stringify(matFields(B.higher)), `${JSON.stringify(matFields(A.higher))} vs ${JSON.stringify(matFields(B.higher))}`);
  check('material: the demoted (lower-id p1) pull is materially identical across both orders (ONLY lateEntry differs)', JSON.stringify(matFields(A.lower)) === JSON.stringify(matFields(B.lower)), `${JSON.stringify(matFields(A.lower))} vs ${JSON.stringify(matFields(B.lower))}`);

  // ── Provenance does not alter current status or production between orders ──
  const prodA = (await db.ref('production/EqOrdA').once('value')).val() || {};
  const prodB = (await db.ref('production/EqOrdB').once('value')).val() || {};
  const bucketN = (o) => { const d = Object.keys(o).find((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)); return d ? o[d].n : null; };
  check('provenance does NOT alter production: both pulls counted in the date bucket in BOTH orders', bucketN(prodA) === 2 && bucketN(prodB) === 2, `A=${bucketN(prodA)} B=${bucketN(prodB)}`);

  console.log('\n=== EQUAL-TIME ARRIVAL-ORDER DETERMINISM (real processIncomingPull) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[equalorder] fatal', e); process.exit(2); });
