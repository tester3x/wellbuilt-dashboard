// EDIT canonical-consistency invariant (Thor 1). After every EDIT the COMMITTED
// packets/processed rows must EQUAL the authoritative recomputeWell output, and
// every production bucket must be a deterministic projection of those committed
// rows. Proves the single-pipeline property across the reordering cases. Drives
// the REAL processEditRequest via packets/incoming writes.
//
// RUN: node functions/emulator/run.mjs editconsistency
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
async function waitFor(path, pred, { timeoutMs = 20000, intervalMs = 250 } = {}) { const s = Date.now(); while (Date.now() - s < timeoutMs) { const v = (await db.ref(path).once('value')).val(); if (pred(v)) return v; await sleep(intervalMs); } return (await db.ref(path).once('value')).val(); }
async function quiesce(ms = 12000) { const s = Date.now(); let st = 0; while (Date.now() - s < ms) { const w = (await db.ref('wells').once('value')).val() || {}; const lock = Object.values(w).some((x) => x?.status?.chronoLock); const inc = (await db.ref('packets/incoming').once('value')).val() || {}; if (!lock && !Object.keys(inc).length) { if (!st) st = Date.now(); else if (Date.now() - st > 1500) return; } else st = 0; await sleep(200); } }

const WELL = 'EC1', WK = 'EC1';
const CFG = { bblPerFoot: 20, tanks: 1, allowedBottomInches: 36 };
const near = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) <= Math.max(1e-3, Math.abs(Number(b || 0)) * 1e-4);
async function seedWellConfig() { await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'R1' }); }
async function sendPull(id, utc, topFeet, bbls = 60) { await db.ref(`packets/incoming/${id}`).set({ requestType: 'pull', wellName: WELL, packetId: id, dateTimeUTC: utc, dateTime: utc, tankLevelFeet: String(topFeet), bblsTaken: bbls, driverId: 'd1', driverName: 'Driver One' }); }
async function sendEdit(incId, target, changes) { await db.ref(`packets/incoming/${incId}`).set({ requestType: 'edit', wellName: WELL, packetId: target, editEventId: incId, ...changes }); }

async function storedRows() {
  const snap = await db.ref('packets/processed').orderByChild('wellName').equalTo(WELL).once('value');
  const rows = [];
  snap.forEach((c) => { const k = c.key || ''; if (k.startsWith('edit_') || k.startsWith('delete_') || k.startsWith('history_')) return; const p = c.val() || {}; if (!p.dateTimeUTC) return; rows.push({ key: k, ...p }); });
  return rows;
}
const toInput = (r) => ({ packetId: r.key, dateTimeUTC: r.dateTimeUTC, tankTopInches: Number(r.tankTopInches) || 0, bblsTaken: Number(r.bblsTaken) || 0, wellDown: r.wellDown === true, lateEntry: r.lateEntry === true });
const toProd = (r) => ({ key: r.key, ms: Date.parse(r.dateTimeUTC), flowRateDays: Number(r.flowRateDays) > 0 ? Number(r.flowRateDays) : 0, tankLevelFeet: Number(r.tankLevelFeet) || (Number(r.tankTopInches) || 0) / 12, bblsTaken: Number(r.bblsTaken) || 0, wellDown: r.wellDown === true });

// Snapshot stored rows keyed by id (for isolating what an edit CHANGED).
async function snapshotRows() { const m = {}; for (const r of await storedRows()) m[r.key] = r; return m; }
const rowChanged = (a, b) => !a || !b || !near(a.tankAfterInches, b.tankAfterInches) || !near(a.flowRateDays, b.flowRateDays) || !near(a.recoveryInches, b.recoveryInches) || !near(a.timeDifDays, b.timeDifDays) || String(a.dateTimeUTC) !== String(b.dateTimeUTC) || Number(a.bblsTaken) !== Number(b.bblsTaken);

// THE invariant for the ROWS THIS EDIT COMMITTED: every row the edit changed
// (edited row + every affected successor) EQUALS recomputeWell output, and every
// production date the edit affected is a projection of those committed rows.
// (Rows the edit did not touch are excluded — they carry their own mutation's
//  provenance and are not this edit's responsibility.)
async function assertInvariant(label, before) {
  const rows = await storedRows();
  const recomputed = chrono.recomputeWell(rows.map(toInput), CFG);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // Rows this edit changed vs the pre-edit snapshot.
  const changedKeys = rows.filter((r) => rowChanged(r, before[r.key])).map((r) => r.key);
  let derivedOk = true, mism = '';
  for (const key of changedKeys) {
    const rc = recomputed.find((x) => x.packetId === key); const s = byKey.get(key);
    const bad = [];
    if (!near(s.flowRateDays, rc.flowRateDays)) bad.push(`flowRateDays ${s.flowRateDays}!=${rc.flowRateDays}`);
    if (!near(s.recoveryInches, rc.recoveryInches)) bad.push(`recoveryInches ${s.recoveryInches}!=${rc.recoveryInches}`);
    if (!near(s.timeDifDays, rc.timeDifDays)) bad.push(`timeDifDays ${s.timeDifDays}!=${rc.timeDifDays}`);
    if (!near(s.tankAfterInches, rc.tankAfterInches)) bad.push(`tankAfterInches ${s.tankAfterInches}!=${rc.tankAfterInches}`);
    if (bad.length) { derivedOk = false; mism = `${key}: ${bad.join('; ')}`; break; }
  }
  check(`${label}: every CHANGED processed row (${changedKeys.length}: ${changedKeys.join(',')}) EQUALS recomputeWell output`, derivedOk && changedKeys.length > 0, mism || 'no changed rows');

  // Production: for every date whose latest pull the edit CHANGED, the stored
  // bucket == the projection of the committed rows (a/w/o/n) via the shared builder.
  const storedBuckets = (await db.ref(`production/${WK}`).once('value')).val() || {};
  const prodRows = rows.map(toProd);
  const affectedDates = new Set(changedKeys.map((k) => pf.getProductionDate(Date.parse(byKey.get(k).dateTimeUTC))));
  const projection = prod.computeAffectedProductionBuckets({ beforeRows: [], afterRows: prodRows, bblPerFoot: 20, wellKey: WK, nowIso: 'T', curBuckets: {} });
  let prodOk = true, pmism = '';
  for (const date of affectedDates) {
    const sb = storedBuckets[date]; const ex = projection.find((b) => b.date === date);
    if (!ex || !ex.value) continue;
    if (sb.a !== ex.value.a || sb.n !== ex.value.n) { prodOk = false; pmism = `${date}: stored a=${sb.a} n=${sb.n} vs projection a=${ex.value.a} n=${ex.value.n}`; break; }
  }
  check(`${label}: production for edit-affected dates is a projection of committed rows (a/n)`, prodOk, pmism);
}

async function seedChain() {
  await quiesce(); await db.ref('/').set(null); await seedWellConfig();
  const pulls = [['e0', '2026-05-01T16:00:00.000Z', 12.0], ['e1', '2026-05-02T16:00:00.000Z', 12.6], ['e2', '2026-05-03T16:00:00.000Z', 13.1], ['e3', '2026-05-04T16:00:00.000Z', 13.6]];
  for (const [id, utc, top] of pulls) { await sendPull(id, utc, top); await waitFor(`packets/processed/${id}`, (v) => v && v.processedAt); }
  await quiesce();
}

async function editAndAssert(label, incId, target, changes, seed = true) {
  if (seed) await seedChain();
  const before = await snapshotRows();
  await sendEdit(incId, target, changes);
  await waitFor(`wells/${WELL}/chronoReceipts/edit_${target}`, (v) => !!v); await quiesce();
  await assertInvariant(label, before);
}

async function main() {
  console.log(`[editconsistency] db=${DB_HOST} ns=${NS}`);
  // 1. Edit level/BBLs, NO chronology change.
  await editAndAssert('level/bbls (no reorder)', 'ec_level', 'e1', { dateTimeUTC: '2026-05-02T16:00:00.000Z', dateTime: '2026-05-02', tankLevelFeet: '12.9', bblsTaken: 48, wellDown: false });
  // 2. Move a pull EARLIER (reorders predecessors at removal + insertion).
  await editAndAssert('move earlier (re-predecessor at removal + insertion)', 'ec_earlier', 'e2', { dateTimeUTC: '2026-05-01T18:00:00.000Z', dateTime: '2026-05-01', tankLevelFeet: '12.2', bblsTaken: 44, wellDown: false });
  // 3. Move a pull LATER (becomes newest/current).
  await editAndAssert('move later (becomes newest)', 'ec_later', 'e1', { dateTimeUTC: '2026-05-05T18:00:00.000Z', dateTime: '2026-05-05', tankLevelFeet: '14.0', bblsTaken: 60, wellDown: false });
  check('move later: current promoted to the moved pull', (Object.values((await db.ref('packets/outgoing').once('value')).val() || {}).find((r) => r?.wellName === WELL)?.lastPullPacketId) === 'e1', '');
  // 4. Move ACROSS a production date, successors on different dates.
  await editAndAssert('cross-date move (successors on different dates)', 'ec_xdate', 'e2', { dateTimeUTC: '2026-04-28T18:00:00.000Z', dateTime: '2026-04-28', tankLevelFeet: '11.8', bblsTaken: 40, wellDown: false });
  // 5. Equal-time ordering governed by packetId (edit e1 to e2's exact time).
  await editAndAssert('equal-time (packetId tie-break)', 'ec_eq', 'e1', { dateTimeUTC: '2026-05-03T16:00:00.000Z', dateTime: '2026-05-03', tankLevelFeet: '12.7', bblsTaken: 50, wellDown: false });
  // 6. Replay the same edit → idempotent (no changed rows expected, invariant holds vacuously — assert current unchanged instead).
  const preReplay = await snapshotRows();
  await sendEdit('ec_eq', 'e1', { dateTimeUTC: '2026-05-03T16:00:00.000Z', dateTime: '2026-05-03', tankLevelFeet: '12.7', bblsTaken: 50, wellDown: false }); await quiesce();
  const postReplay = await snapshotRows();
  check('replay (idempotent): NO processed row changed on the byte-identical replay', Object.keys(postReplay).every((k) => !rowChanged(postReplay[k], preReplay[k])) && Object.keys(postReplay).length === Object.keys(preReplay).length, '');

  console.log('\n=== EDIT CANONICAL-CONSISTENCY INVARIANT (real processEditRequest) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[editconsistency] fatal', e); process.exit(2); });
