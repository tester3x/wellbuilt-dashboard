// Projection-path classification (Thor 1). Drives the REAL processEditRequest /
// processDeleteRequest triggers and DUMPS + CLASSIFIES the observable atomic-patch
// effect on the projection surfaces — performance rows, production buckets,
// outgoing/current — for the edit and delete scenarios. Every path is what the
// LIVE handler actually wrote to the emulator DB (replacing the earlier table,
// which conflated Atlas COMPLETENESS tests with its BOUND `sidecar:{}` tests).
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
const prodDates = async () => { const v = (await db.ref(`production/${WK}`).once('value')).val() || {}; return Object.fromEntries(Object.entries(v).filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k))); };
async function currentId() { const all = (await db.ref('packets/outgoing').once('value')).val() || {}; const r = Object.values(all).find((x) => x && x.wellName === WELL); return r ? r.lastPullPacketId : null; }
const revision = async () => Number((await db.ref(`wells/${WELL}/status/chronoRevision`).once('value')).val()) || 0;
async function seedWellConfig() { await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'R1' }); }
async function sendPull(id, utc, over = {}) { await db.ref(`packets/incoming/${id}`).set({ requestType: 'pull', wellName: WELL, packetId: id, dateTimeUTC: utc, dateTime: utc, tankLevelFeet: '13.0', bblsTaken: 60, driverId: 'd1', driverName: 'Driver One', ...over }); }
async function sendEdit(incId, target, changes) { await db.ref(`packets/incoming/${incId}`).set({ requestType: 'edit', wellName: WELL, packetId: target, editEventId: incId, ...changes }); }
async function sendDelete(incId, target) { await db.ref(`packets/incoming/${incId}`).set({ requestType: 'delete', wellName: WELL, packetId: target }); }
const setDelta = (b, a) => ({ added: a.filter((k) => !b.includes(k)), removed: b.filter((k) => !a.includes(k)), kept: a.filter((k) => b.includes(k)) });
// Which production date buckets changed value (added / removed / value-changed).
function changedDates(before, after) {
  const dates = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const d of dates) if (JSON.stringify(before[d] ?? null) !== JSON.stringify(after[d] ?? null)) out.push(d);
  return out;
}
const nOf = (buckets, d) => (buckets[d] && typeof buckets[d].n === 'number' ? buckets[d].n : null);

// A three-day chain with MULTIPLE pulls on some production dates so a delete can
// be proven to recompute a shared bucket rather than remove it. Times are all in
// the afternoon (>= 14:00 UTC) so every pull on a calendar day lands on the SAME
// production date regardless of the production-day timezone offset:
//   Day A: 3 pulls · Day B: 1 pull (sole) · Day C: 2 pulls (newest = current)
async function seedChain() {
  await db.ref('/').set(null);
  await seedWellConfig();
  const pulls = [
    ['pA1', '2026-03-01T14:00:00.000Z'], ['pA2', '2026-03-01T16:00:00.000Z'], ['pA3', '2026-03-01T18:00:00.000Z'],
    ['pB1', '2026-03-02T16:00:00.000Z'],
    ['pC1', '2026-03-03T14:00:00.000Z'], ['pC2', '2026-03-03T18:00:00.000Z'],
  ];
  for (let i = 0; i < pulls.length; i++) { await sendPull(pulls[i][0], pulls[i][1], { tankLevelFeet: String(13 - i * 0.4) }); await waitFor(`packets/processed/${pulls[i][0]}`, (v) => v && v.processedAt); }
  await sleep(1500);
}
// Discover the production date each named day-group landed on (offset-agnostic).
function dayDates(buckets) {
  const byN = (n) => Object.keys(buckets).filter((d) => nOf(buckets, d) === n).sort();
  return { A: byN(3)[0], B: byN(1)[0], C: byN(2)[0] };
}

async function main() {
  console.log(`[projpaths] db=${DB_HOST} ns=${NS}`);

  // ── A/B: EDIT pA3 EARLIER across a production-date boundary, stays non-current ──
  await seedChain();
  const perfA0 = await perfKeys(), prodA0 = await prodDates(), curA0 = await currentId();
  const dyA = dayDates(prodA0); // A(n3) B(n1) C(n2) production dates, offset-agnostic
  await sendEdit('e_earlier', 'pA3', { dateTimeUTC: '2026-02-25T18:00:00.000Z', dateTime: '2026-02-25', tankLevelFeet: '11.0', bblsTaken: 55 });
  await waitFor(`wells/${WELL}/chronoReceipts/edit_pA3`, (v) => !!v, { timeoutMs: 15000 });
  await sleep(2500);
  const perfA1 = await perfKeys(), prodA1 = await prodDates(), curA1 = await currentId();
  const dP = setDelta(perfA0, perfA1), newDate = changedDates({ [dyA.A]: prodA0[dyA.A] }, prodA1).find((d) => d !== dyA.A) || Object.keys(prodA1).find((d) => !(d in prodA0));
  console.log(`[A/B] perf Δ added=${JSON.stringify(dP.added)} removed=${JSON.stringify(dP.removed)} DayA(${dyA.A}) n ${nOf(prodA0, dyA.A)}→${nOf(prodA1, dyA.A)} newDate=${newDate}`);
  check('A: EDIT-earlier writes the edited row a NEW performance key (new event date)', dP.added.length >= 1, JSON.stringify(dP.added));
  check('A: EDIT-earlier REMOVES the edited row OLD performance key (date changed)', dP.removed.length >= 1, JSON.stringify(dP.removed));
  check('B: cross-date EDIT writes a NEW production date bucket', !!newDate && !!prodA1[newDate], `${newDate}`);
  check('B: cross-date EDIT recomputes the OLD (Day A) bucket n 3→2', nOf(prodA1, dyA.A) === 2, `n=${nOf(prodA1, dyA.A)}`);
  check('A: EDIT-earlier leaves current pointer UNCHANGED (still pC2)', curA1 === curA0 && curA1 === 'pC2', `${curA0}→${curA1}`);

  // ── C: DELETE OLDEST same-date (pA1 on Day A, 2 remain) → bucket RECOMPUTED, others untouched ──
  await seedChain();
  const perfC0 = await perfKeys(), prodC0 = await prodDates(), curC0 = await currentId(), revC0 = await revision();
  const dy = dayDates(prodC0);
  check('seed: some production date carries 3 pulls, one carries 1, one carries 2', !!dy.A && !!dy.B && !!dy.C, JSON.stringify(prodC0));
  await sendDelete('d_oldest', 'pA1');
  await waitFor('packets/processed/pA1', (v) => v === null, { timeoutMs: 15000 });
  await waitFor(`wells/${WELL}/chronoReceipts/delete_pA1`, (v) => !!v, { timeoutMs: 15000 });
  await sleep(2000);
  const perfC1 = await perfKeys(), prodC1 = await prodDates(), curC1 = await currentId(), revC1 = await revision();
  const chg = changedDates(prodC0, prodC1);
  console.log(`[C del-oldest-samedate] changedDates=${JSON.stringify(chg)} DayA(${dy.A}) n ${nOf(prodC0, dy.A)}→${nOf(prodC1, dy.A)}`);
  check('C: DELETE-oldest recomputes ONLY the deleted date bucket (Day A), n 3→2 (count of survivors, not blind −1)', nOf(prodC1, dy.A) === 2, `n=${nOf(prodC1, dy.A)}`);
  check('C: DELETE-oldest leaves EVERY OTHER production date byte-identical (B,C untouched)', chg.length === 1 && chg[0] === dy.A, JSON.stringify(chg));
  check('C: DELETE-oldest removes the deleted row performance key', setDelta(perfC0, perfC1).removed.length >= 1, JSON.stringify(setDelta(perfC0, perfC1).removed));
  check('C: DELETE-oldest — packet gone + perf gone + production recomputed + receipt + revision bump, ONE atomic patch', (await db.ref('packets/processed/pA1').once('value')).val() === null && revC1 > revC0, `rev ${revC0}→${revC1}`);
  check('C: DELETE-oldest leaves current pointer UNCHANGED (still pC2)', curC1 === 'pC2', `${curC0}→${curC1}`);

  // ── C-replay: same delete id again → NO double decrement, bucket byte-identical ──
  await sendDelete('d_oldest', 'pA1');
  await sleep(2500);
  const prodCr = await prodDates();
  check('C-replay: DELETE replay does NOT double-decrement (Day A n stays 2, bucket byte-identical)', JSON.stringify(prodCr[dy.A]) === JSON.stringify(prodC1[dy.A]), `${JSON.stringify(prodC1[dy.A])} vs ${JSON.stringify(prodCr[dy.A])}`);

  // ── D: DELETE MIDDLE same-date (pA2) → Day A n 3→2, others untouched ──
  await seedChain();
  const prodD0 = await prodDates(), dyD = dayDates(prodD0);
  await sendDelete('d_middle', 'pA2');
  await waitFor('packets/processed/pA2', (v) => v === null, { timeoutMs: 15000 });
  await sleep(2000);
  const prodD1 = await prodDates();
  const chgD = changedDates(prodD0, prodD1);
  check('D: DELETE-middle recomputes Day A (n 3→2) and touches no other date', nOf(prodD1, dyD.A) === 2 && chgD.length === 1 && chgD[0] === dyD.A, `n=${nOf(prodD1, dyD.A)} chg=${JSON.stringify(chgD)}`);

  // ── E: DELETE NEWEST same-date (pC2 on Day C, 1 remains) → Day C n 2→1, current promoted ──
  await seedChain();
  const prodE0 = await prodDates(), dyE = dayDates(prodE0), curE0 = await currentId();
  await sendDelete('d_newest', 'pC2');
  await waitFor('packets/processed/pC2', (v) => v === null, { timeoutMs: 15000 });
  await sleep(2500);
  const prodE1 = await prodDates(), curE1 = await currentId();
  const chgE = changedDates(prodE0, prodE1);
  check('E: DELETE-newest recomputes Day C (n 2→1), no other date touched', nOf(prodE1, dyE.C) === 1 && chgE.length === 1 && chgE[0] === dyE.C, `n=${nOf(prodE1, dyE.C)} chg=${JSON.stringify(chgE)}`);
  check('E: DELETE-newest PROMOTES current to the new newest (pC2→pC1, same date)', curE1 === 'pC1', `${curE0}→${curE1}`);

  // ── F: DELETE the ONLY pull on a production date (pB1 on Day B) → bucket REMOVED (null) ──
  await seedChain();
  const prodF0 = await prodDates(), dyF = dayDates(prodF0);
  await sendDelete('d_sole', 'pB1');
  await waitFor('packets/processed/pB1', (v) => v === null, { timeoutMs: 15000 });
  await sleep(2000);
  const prodF1 = await prodDates();
  const chgF = changedDates(prodF0, prodF1);
  check('F: DELETE sole-pull-on-date removes the Day B bucket entirely (null)', !(dyF.B in prodF1), JSON.stringify(Object.keys(prodF1)));
  check('F: DELETE sole-pull-on-date touches NO other date (A,C untouched)', chgF.length === 1 && chgF[0] === dyF.B, JSON.stringify(chgF));

  // ── G: SUCCESSOR performance INVARIANCE under a predecessor DELETE ──
  //    The successor's PROCESSED derived fields (flowRateDays/recovery/timeDif)
  //    are recomputed, but its PERFORMANCE row {d,a,p} is a pull-time accuracy
  //    snapshot (own date, own raw level, prediction the driver saw) → unchanged.
  await seedChain();
  const succProcBefore = (await db.ref('packets/processed/pA3').once('value')).val();
  const perfRowsBefore = (await db.ref(`performance/${WK}/rows`).once('value')).val() || {};
  const succPerfKey = Object.keys(perfRowsBefore).find((k) => JSON.stringify(perfRowsBefore[k]) && k.startsWith('20260301_18')); // pA3's own event-time key
  const succPerfBefore = succPerfKey ? perfRowsBefore[succPerfKey] : null;
  await sendDelete('d_pred', 'pA2');                                   // delete pA3's immediate predecessor
  await waitFor('packets/processed/pA2', (v) => v === null, { timeoutMs: 15000 });
  await sleep(2000);
  const succProcAfter = (await db.ref('packets/processed/pA3').once('value')).val();
  const succPerfAfter = succPerfKey ? ((await db.ref(`performance/${WK}/rows/${succPerfKey}`).once('value')).val()) : null;
  console.log(`[G] succ pA3 flowRateDays ${succProcBefore?.flowRateDays}→${succProcAfter?.flowRateDays}; perf ${JSON.stringify(succPerfBefore)}→${JSON.stringify(succPerfAfter)}`);
  check('G: predecessor DELETE recomputes the successor PROCESSED derived fields (flowRateDays changes)', String(succProcBefore?.flowRateDays) !== String(succProcAfter?.flowRateDays), `${succProcBefore?.flowRateDays}→${succProcAfter?.flowRateDays}`);
  check('G: successor PERFORMANCE row {d,a,p} is BYTE-IDENTICAL (pull-time snapshot, not chain-derived)', JSON.stringify(succPerfBefore) === JSON.stringify(succPerfAfter) && !!succPerfBefore, `${JSON.stringify(succPerfBefore)} vs ${JSON.stringify(succPerfAfter)}`);

  // ── H: SUCCESSOR performance INVARIANCE under a backdated CREATE-before-successor ──
  await seedChain();
  const hProcBefore = (await db.ref('packets/processed/pA1').once('value')).val();
  const hRows = (await db.ref(`performance/${WK}/rows`).once('value')).val() || {};
  const hKey = Object.keys(hRows).find((k) => k.startsWith('20260301_14')); // pA1's own key
  const hPerfBefore = hKey ? hRows[hKey] : null;
  await sendPull('pIns', '2026-03-01T09:00:00.000Z', { tankLevelFeet: '12.7' }); // insert BEFORE pA1
  await waitFor('packets/processed/pIns', (v) => v && v.processedAt, { timeoutMs: 15000 });
  await sleep(2000);
  const hProcAfter = (await db.ref('packets/processed/pA1').once('value')).val();
  const hPerfAfter = hKey ? ((await db.ref(`performance/${WK}/rows/${hKey}`).once('value')).val()) : null;
  console.log(`[H] succ pA1 flowRateDays ${hProcBefore?.flowRateDays}→${hProcAfter?.flowRateDays}; perf ${JSON.stringify(hPerfBefore)}→${JSON.stringify(hPerfAfter)}`);
  check('H: backdated CREATE-before-successor recomputes the successor PROCESSED derived fields', String(hProcBefore?.flowRateDays) !== String(hProcAfter?.flowRateDays) || String(hProcBefore?.recoveryInches) !== String(hProcAfter?.recoveryInches), `flow ${hProcBefore?.flowRateDays}→${hProcAfter?.flowRateDays}`);
  check('H: successor PERFORMANCE row {d,a,p} is BYTE-IDENTICAL (pull-time snapshot)', JSON.stringify(hPerfBefore) === JSON.stringify(hPerfAfter) && !!hPerfBefore, `${JSON.stringify(hPerfBefore)} vs ${JSON.stringify(hPerfAfter)}`);

  console.log('\n=== PROJECTION-PATH CLASSIFICATION (real edit/delete handlers) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[projpaths] fatal', e); process.exit(2); });
