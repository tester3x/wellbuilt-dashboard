// DELETE production POST-CASCADE value proof (Thor 1). Proves the committed
// production bucket is computed from the POST-cascade canonical rows (the
// surviving successor's RECOMPUTED flowRateDays), NOT the stale pre-delete stored
// value. Uses the SAME compiled pure functions the handler uses, fed both ways.
//
// RUN: node functions/emulator/run.mjs delprodvalue
import admin from 'firebase-admin';
import * as chrono from '../lib/chronoRecompute.js';
import * as prod from '../lib/editProduction.js';
import * as pf from '../lib/productionFormulas.js';

const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002';
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const NS = `${PROJECT}-default-rtdb`;
admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${DB_HOST}/?ns=${NS}` });
const db = admin.database();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
async function waitFor(path, pred, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) { const v = (await db.ref(path).once('value')).val(); if (pred(v)) return v; await sleep(intervalMs); }
  return (await db.ref(path).once('value')).val();
}
const WELL = 'PV1', WK = 'PV1';
const CFG = { bblPerFoot: 20, tanks: 1, allowedBottomInches: 36 };
async function seedWellConfig() { await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'R1' }); }
async function sendPull(id, utc, topFeet, bbls) { await db.ref(`packets/incoming/${id}`).set({ requestType: 'pull', wellName: WELL, packetId: id, dateTimeUTC: utc, dateTime: utc, tankLevelFeet: String(topFeet), bblsTaken: bbls, driverId: 'd1', driverName: 'Driver One' }); }
async function sendDelete(incId, target) { await db.ref(`packets/incoming/${incId}`).set({ requestType: 'delete', wellName: WELL, packetId: target }); }

// Build ChronoPullInput[] + stored EditProdRow[] from the live processed rows.
async function readRows() {
  const snap = await db.ref('packets/processed').orderByChild('wellName').equalTo(WELL).once('value');
  const chain = [], stored = [];
  snap.forEach((c) => {
    const k = c.key || ''; if (k.startsWith('edit_') || k.startsWith('delete_') || k.startsWith('history_')) return;
    const p = c.val() || {}; if (!p.dateTimeUTC) return;
    chain.push({ packetId: k, dateTimeUTC: p.dateTimeUTC, tankTopInches: Number(p.tankTopInches) || 0, bblsTaken: Number(p.bblsTaken) || 0, wellDown: p.wellDown === true });
    stored.push({ key: k, ms: Date.parse(p.dateTimeUTC), flowRateDays: Number(p.flowRateDays) > 0 ? Number(p.flowRateDays) : 0, tankLevelFeet: Number(p.tankLevelFeet) || (Number(p.tankTopInches) || 0) / 12, bblsTaken: Number(p.bblsTaken) || 0, wellDown: p.wellDown === true });
  });
  return { chain, stored };
}
const toRows = (recomputed) => recomputed.map((r) => ({ key: r.packetId, ms: Date.parse(r.dateTimeUTC), flowRateDays: Number(r.flowRateDays) > 0 ? Number(r.flowRateDays) : 0, tankLevelFeet: Number(r.tankTopInches) / 12, bblsTaken: Number(r.bblsTaken) || 0, wellDown: r.wellDown === true }));

async function main() {
  await db.ref('/').set(null);
  await seedWellConfig();
  console.log(`[delprodvalue] db=${DB_HOST} ns=${NS}`);
  // W (far predecessor, earlier date) · X (deleted, Day D) · Y (successor, Day D latest) · Z (current, later)
  // Rising tops → positive recovery → non-trivial flow rates; X is CLOSE to Y, W is FAR,
  // so deleting X makes Y's predecessor W (large gap) → Y's flowRateDays changes materially.
  await sendPull('Wpv', '2026-04-01T14:00:00.000Z', 12.0, 60); await waitFor('packets/processed/Wpv', (v) => v && v.processedAt);
  await sendPull('Xpv', '2026-04-02T14:00:00.000Z', 13.0, 60); await waitFor('packets/processed/Xpv', (v) => v && v.processedAt);
  await sendPull('Ypv', '2026-04-02T18:00:00.000Z', 13.4, 60); await waitFor('packets/processed/Ypv', (v) => v && v.processedAt);
  await sendPull('Zpv', '2026-04-03T14:00:00.000Z', 14.0, 60); await waitFor('packets/processed/Zpv', (v) => v && v.processedAt);
  await sleep(2000);

  const dDate = pf.getProductionDate(Date.parse('2026-04-02T14:00:00.000Z')); // deleted pull's production date
  const yBefore = (await db.ref('packets/processed/Ypv').once('value')).val();
  const bucketBefore = (await db.ref(`production/${WK}/${dDate}`).once('value')).val();
  const { chain, stored } = await readRows();
  const deletedMs = Date.parse('2026-04-02T14:00:00.000Z');
  const curBuckets = { [dDate]: (await db.ref(`production/${WK}/${dDate}`).once('value')).val() };
  // STALE expected: stored (pre-delete) rows minus X → Y keeps its OLD flowRateDays.
  const staleExpected = prod.computeDeleteProductionBuckets({ survivingRows: stored.filter((r) => r.key !== 'Xpv'), deletedMs, bblPerFoot: 20, wellKey: WK, nowIso: 'T', curBuckets })[0];
  // POST-CASCADE expected: recompute the surviving chain → Y gets its NEW flowRateDays.
  const postRows = toRows(chrono.recomputeWell(chain.filter((p) => p.packetId !== 'Xpv'), CFG));
  const postExpected = prod.computeDeleteProductionBuckets({ survivingRows: postRows, deletedMs, bblPerFoot: 20, wellKey: WK, nowIso: 'T', curBuckets })[0];

  // ── delete X through the REAL handler ──
  const paths = {};
  await sendDelete('delX', 'Xpv');
  await waitFor('packets/processed/Xpv', (v) => v === null, { timeoutMs: 15000 });
  await waitFor(`wells/${WELL}/chronoReceipts/delete_Xpv`, (v) => !!v, { timeoutMs: 15000 });
  await sleep(2000);
  const yAfter = (await db.ref('packets/processed/Ypv').once('value')).val();
  const committed = (await db.ref(`production/${WK}/${dDate}`).once('value')).val();
  paths[`packets/processed/Xpv`] = (await db.ref('packets/processed/Xpv').once('value')).val();
  paths[`production/${WK}/${dDate}`] = committed;
  paths[`wells/${WELL}/status/chronoRevision`] = (await db.ref(`wells/${WELL}/status/chronoRevision`).once('value')).val();
  paths[`wells/${WELL}/chronoReceipts/delete_Xpv`] = !!(await db.ref(`wells/${WELL}/chronoReceipts/delete_Xpv`).once('value')).val();

  const aOf = (b) => (b && typeof b.a === 'number' ? b.a : null);
  console.log(`[VALUE] Y flowRateDays  before=${yBefore?.flowRateDays}  after=${yAfter?.flowRateDays}`);
  console.log(`[VALUE] Y processed BEFORE = ${JSON.stringify({ dateTimeUTC: yBefore?.dateTimeUTC, tankTopInches: yBefore?.tankTopInches, tankAfterInches: yBefore?.tankAfterInches, bblsTaken: yBefore?.bblsTaken, timeDifDays: yBefore?.timeDifDays, recoveryInches: yBefore?.recoveryInches, flowRateDays: yBefore?.flowRateDays })}`);
  console.log(`[VALUE] Y processed AFTER  = ${JSON.stringify({ dateTimeUTC: yAfter?.dateTimeUTC, tankTopInches: yAfter?.tankTopInches, tankAfterInches: yAfter?.tankAfterInches, bblsTaken: yAfter?.bblsTaken, timeDifDays: yAfter?.timeDifDays, recoveryInches: yAfter?.recoveryInches, flowRateDays: yAfter?.flowRateDays })}`);
  console.log(`[VALUE] bucket ${dDate} BEFORE   = ${JSON.stringify(bucketBefore)}`);
  console.log(`[VALUE] bucket ${dDate} COMMITTED = ${JSON.stringify(committed)}`);
  console.log(`[VALUE] STALE expected a=${aOf(staleExpected?.value)} value=${JSON.stringify(staleExpected?.value)}`);
  console.log(`[VALUE] POST-CASCADE expected a=${aOf(postExpected?.value)} value=${JSON.stringify(postExpected?.value)}`);
  console.log(`[VALUE] atomic patch paths = ${JSON.stringify(paths, null, 0)}`);

  check('successor Y flowRateDays CHANGES when its predecessor X is deleted', String(yBefore?.flowRateDays) !== String(yAfter?.flowRateDays), `${yBefore?.flowRateDays}→${yAfter?.flowRateDays}`);
  check('post-cascade and stale expected buckets genuinely DIFFER on `a` (the fix matters)', aOf(postExpected?.value) !== aOf(staleExpected?.value), `post=${aOf(postExpected?.value)} stale=${aOf(staleExpected?.value)}`);
  const sameBucket = (x, y) => x && y && x.a === y.a && x.w === y.w && x.o === y.o && x.n === y.n; // all value fields (u = write time, ignored)
  check('committed bucket EQUALS the POST-CASCADE expected value (every field a/w/o/n, u ignored)', sameBucket(committed, postExpected.value), `${JSON.stringify(committed)} vs ${JSON.stringify(postExpected.value)}`);
  check('committed bucket does NOT equal the STALE pre-delete value', aOf(committed) !== aOf(staleExpected?.value), `committed a=${aOf(committed)} stale a=${aOf(staleExpected?.value)}`);

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  console.log(results.join('\n'));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[delprodvalue] fatal', e); process.exit(2); });
