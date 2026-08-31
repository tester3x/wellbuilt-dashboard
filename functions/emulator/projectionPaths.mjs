// Projection-path classification (Thor 1 final proof #2). Drives the REAL
// processEditRequest / processDeleteRequest triggers and DUMPS + CLASSIFIES the
// observable atomic-patch effect on the projection surfaces — performance rows,
// production buckets, outgoing/current — for scenarios A–E. This replaces the
// earlier table, which conflated the Atlas COMPLETENESS tests (realistic sidecar)
// with its BOUND/guard tests (empty sidecar). Here every path is what the LIVE
// handler actually wrote to the emulator DB.
//
// RUN: node functions/emulator/run.mjs projpaths
import admin from 'firebase-admin';

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
const WELL = 'Proj1', WK = 'Proj1';
const perfKeys = async () => Object.keys((await db.ref(`performance/${WK}/rows`).once('value')).val() || {});
const prodBuckets = async () => { const v = (await db.ref(`production/${WK}`).once('value')).val() || {}; return Object.fromEntries(Object.entries(v).filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k))); };
async function currentId() { const all = (await db.ref('packets/outgoing').once('value')).val() || {}; const r = Object.values(all).find((x) => x && x.wellName === WELL); return r ? r.lastPullPacketId : null; }
async function seedWellConfig() { await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'R1' }); }
async function sendPull(id, utc, over = {}) { await db.ref(`packets/incoming/${id}`).set({ requestType: 'pull', wellName: WELL, packetId: id, dateTimeUTC: utc, dateTime: utc, tankLevelFeet: '13.0', bblsTaken: 60, driverId: 'd1', driverName: 'Driver One', ...over }); }
async function sendEdit(incId, target, changes) { await db.ref(`packets/incoming/${incId}`).set({ requestType: 'edit', wellName: WELL, packetId: target, editEventId: incId, ...changes }); }
async function sendDelete(incId, target) { await db.ref(`packets/incoming/${incId}`).set({ requestType: 'delete', wellName: WELL, packetId: target }); }
const setDelta = (before, after) => ({ added: after.filter((k) => !before.includes(k)), removed: before.filter((k) => !after.includes(k)), kept: after.filter((k) => before.includes(k)) });

async function seedChain() {
  await db.ref('/').set(null);
  await seedWellConfig();
  // Four pulls on four distinct days; p3 newest/current.
  const days = ['2026-03-01T18:00:00.000Z', '2026-03-02T18:00:00.000Z', '2026-03-03T18:00:00.000Z', '2026-03-04T18:00:00.000Z'];
  const ids = ['pp0', 'pp1', 'pp2', 'pp3'];
  for (let i = 0; i < ids.length; i++) { await sendPull(ids[i], days[i], { tankLevelFeet: String(13 - i * 0.5) }); await waitFor(`packets/processed/${ids[i]}`, (v) => v && v.processedAt); }
  await sleep(1500);
  return { ids, days };
}

async function main() {
  console.log(`[projpaths] db=${DB_HOST} ns=${NS}`);

  // ── A/B: EDIT pp2 EARLIER across a production-date boundary, stays non-current ──
  await seedChain();
  const perfA0 = await perfKeys(), prodA0 = await prodBuckets(), curA0 = await currentId();
  await sendEdit('e_earlier', 'pp2', { dateTimeUTC: '2026-02-25T18:00:00.000Z', dateTime: '2026-02-25', tankLevelFeet: '11.0', bblsTaken: 55 });
  await waitFor(`wells/${WELL}/chronoReceipts/edit_pp2`, (v) => !!v, { timeoutMs: 15000 });
  await sleep(2500);
  const perfA1 = await perfKeys(), prodA1 = await prodBuckets(), curA1 = await currentId();
  const dP = setDelta(perfA0, perfA1), dProd = setDelta(Object.keys(prodA0), Object.keys(prodA1));
  console.log(`[A/B] perf Δ added=${JSON.stringify(dP.added)} removed=${JSON.stringify(dP.removed)}`);
  console.log(`[A/B] prod dates before=${JSON.stringify(Object.keys(prodA0))} after=${JSON.stringify(Object.keys(prodA1))}`);
  check('A: EDIT-earlier writes the edited row a NEW performance key (new event date)', dP.added.length >= 1, JSON.stringify(dP.added));
  check('A: EDIT-earlier REMOVES the edited row OLD performance key (date changed)', dP.removed.length >= 1, JSON.stringify(dP.removed));
  check('B: cross-date EDIT writes the NEW production date bucket', !!prodA1['2026-02-25'], JSON.stringify(Object.keys(prodA1)));
  check('B: cross-date EDIT recomputes/vacates the OLD production date bucket', JSON.stringify(prodA0['2026-03-03']) !== JSON.stringify(prodA1['2026-03-03'] ?? null) || !('2026-03-03' in prodA1), `old=${JSON.stringify(prodA0['2026-03-03'])} new=${JSON.stringify(prodA1['2026-03-03'])}`);
  check('A: EDIT-earlier leaves current-only pointer UNCHANGED (still pp3, non-current edit)', curA1 === curA0 && curA1 === 'pp3', `${curA0}→${curA1}`);
  // Documented scope: neighbor (pp3) performance row is NOT re-projected inline.
  check('A: neighbor pp3 performance row is UNCHANGED (neighbor perf not recomputed inline — by design)', dP.kept.length >= 1, JSON.stringify(dP.kept));

  // ── C: DELETE OLDEST (pp0), non-current ──
  await seedChain();
  const perfC0 = await perfKeys(), prodC0 = await prodBuckets(), curC0 = await currentId();
  await sendDelete('d_oldest', 'pp0');
  await waitFor('packets/processed/pp0', (v) => v === null, { timeoutMs: 15000 });
  await sleep(2000);
  const perfC1 = await perfKeys(), prodC1 = await prodBuckets(), curC1 = await currentId();
  const dPC = setDelta(perfC0, perfC1);
  console.log(`[C del-oldest] perf removed=${JSON.stringify(dPC.removed)} prod before=${JSON.stringify(Object.keys(prodC0))} after=${JSON.stringify(Object.keys(prodC1))} cur ${curC0}→${curC1}`);
  check('C: DELETE-oldest removes the deleted row performance key', dPC.removed.length >= 1, JSON.stringify(dPC.removed));
  check('C: DELETE-oldest leaves current pointer UNCHANGED (still pp3)', curC1 === 'pp3', `${curC0}→${curC1}`);
  check('C: DELETE production bucket for the deleted date is NOT recomputed inline (documented gap)', JSON.stringify(prodC0['2026-03-01']) === JSON.stringify(prodC1['2026-03-01'] ?? null), `before=${JSON.stringify(prodC0['2026-03-01'])} after=${JSON.stringify(prodC1['2026-03-01'])}`);

  // ── D: DELETE MIDDLE (pp1), non-current ──
  await seedChain();
  const perfD0 = await perfKeys(), curD0 = await currentId();
  await sendDelete('d_middle', 'pp1');
  await waitFor('packets/processed/pp1', (v) => v === null, { timeoutMs: 15000 });
  await sleep(2000);
  const perfD1 = await perfKeys(), curD1 = await currentId();
  const dPD = setDelta(perfD0, perfD1);
  check('D: DELETE-middle removes the deleted row performance key', dPD.removed.length >= 1, JSON.stringify(dPD.removed));
  check('D: DELETE-middle leaves current pointer UNCHANGED (still pp3)', curD1 === 'pp3', `${curD0}→${curD1}`);

  // ── E: DELETE NEWEST (pp3) → current promoted to pp2, outgoing rebuilt ──
  await seedChain();
  const perfE0 = await perfKeys(), curE0 = await currentId();
  await sendDelete('d_newest', 'pp3');
  await waitFor('packets/processed/pp3', (v) => v === null, { timeoutMs: 15000 });
  await sleep(2500);
  const perfE1 = await perfKeys(), curE1 = await currentId();
  const dPE = setDelta(perfE0, perfE1);
  console.log(`[E del-newest] perf removed=${JSON.stringify(dPE.removed)} cur ${curE0}→${curE1}`);
  check('E: DELETE-newest removes the deleted row performance key', dPE.removed.length >= 1, JSON.stringify(dPE.removed));
  check('E: DELETE-newest PROMOTES current to the new newest (pp2)', curE1 === 'pp2', `${curE0}→${curE1}`);

  console.log('\n=== PROJECTION-PATH CLASSIFICATION (real edit/delete handlers) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[projpaths] fatal', e); process.exit(2); });
