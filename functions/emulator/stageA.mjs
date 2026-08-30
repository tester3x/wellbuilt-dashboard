// Stage-A mixed-generation harness (predeploy gate Rev-3 item 3).
//
// Runs the EXACT function set that is live during the Stage-A deploy window:
//   NEW gated producers (this branch):  ingestWbmPull, ingestWbmEdit, adminSubmitPullEdit
//   OLD deployed consumers (c7378d6):   processIncomingPull, processEditRequest,
//                                        processDeleteRequest, watchdogStrandedPackets
// (wired together by functions/emulator/stageA-codebase, loaded via firebase.stageA.json)
//
// Proves, while the gate is OPEN, that the newest producer packet shapes are
// accepted and applied by the OLD (pre-chrono, sequential) consumers — no
// chrono lock/receipt, just the deployed pattern. Then proves that CLOSING the
// gate stops all three producers, already-accepted old work drains, the OLD
// watchdog leaves NO new stranded work after the empty/drained check, and the
// drained window leaves no in-flight commit-owning old invocation.
//
// RUN: node functions/emulator/run.mjs stagea   (which builds the old lib first)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb` });
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
// Idempotent init: this process AND the required OLD lib both initializeApp.
const _init = admin.initializeApp.bind(admin);
admin.initializeApp = (...a) => { try { return _init(...a); } catch (e) { if (e?.code === 'app/duplicate-app') return admin.app(); throw e; } };
admin.initializeApp();
const db = admin.database();
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
const url = (fn) => `http://127.0.0.1:5003/${PROJECT_ID}/us-central1/${fn}`;

// The REAL old watchdog handler, for a faithful "leaves nothing stranded" probe.
const oldLib = require(process.env.WB_OLD_LIB);

let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const val = async (p) => (await db.ref(p).once('value')).val();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WELL = 'Gabriel 1', DRIVER_ID = 'emu-driver-1', GATE = 'system/maintenance/wbmMutations';

async function callFn(fn, data, idToken) {
  const res = await fetch(url(fn), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
async function driverToken() {
  const uid = `driver_${DRIVER_ID}`;
  await admin.auth().createUser({ uid }).catch(() => {});
  await admin.auth().setCustomUserClaims(uid, { kind: 'driver', driverId: DRIVER_ID, companyId: 'liquid-gold', roles: ['driver'] });
  const custom = await admin.auth().createCustomToken(uid);
  const j = await (await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })).json();
  return j.idToken;
}
async function adminToken(uid = 'dash-admin-1') {
  await admin.auth().createUser({ uid }).catch(() => {});
  const custom = await admin.auth().createCustomToken(uid);
  const j = await (await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })).json();
  return j.idToken;
}
async function seedBase() {
  await db.ref('/').set(null);
  await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'Gabriels', companyId: 'liquid-gold' });
  await db.ref(`drivers/profiles/${DRIVER_ID}`).set({ active: true, companyId: 'liquid-gold', displayName: 'Emu Driver', assignedRoutes: ['Gabriels'], assignedWells: [] });
  await admin.firestore().collection('driver_credentials').doc(DRIVER_ID).set({ active: true });
  await db.ref('packets/incoming_version').set(7000);
  await db.ref('users/dash-admin-1').set({ role: 'admin', displayName: 'Dash Admin' });
}
const pull = (id, over = {}) => ({ requestType: 'pull', wellName: WELL, dateTimeUTC: '2026-08-27T15:00:00.000Z', dateTime: '8/27 10AM', tankLevelFeet: 9, bblsTaken: 40, packetId: id, idempotencyKey: id, ...over });
async function waitProcessed(id, ms = 14000) { const s = Date.now(); while (Date.now() - s < ms) { if (await val(`packets/processed/${id}`)) return true; await sleep(300); } return false; }
const incomingKeys = async () => Object.keys((await val('packets/incoming')) || {});
const anyChronoLock = async () => { const w = (await val('wells')) || {}; return Object.values(w).some((x) => x?.status?.chronoLock); };
const anyChronoReceipt = async () => { const w = (await val('wells')) || {}; return Object.values(w).some((x) => x?.chronoReceipts && Object.keys(x.chronoReceipts).length); };

async function main() {
  await seedBase();
  const drvTok = await driverToken();
  const admTok = await adminToken();
  check('driver + admin tokens issued', !!drvTok && !!admTok);

  // Confirm we are actually running the OLD consumers (sanity: the OLD lib
  // export set has the 4 consumers and NOT the chrono coordinator).
  const oldKeys = Object.keys(oldLib);
  check('mixed bundle uses the OLD deployed consumers (no chrono assembler in that lib)', ['processIncomingPull', 'processEditRequest', 'processDeleteRequest', 'watchdogStrandedPackets'].every((f) => oldKeys.includes(f)) && !oldKeys.includes('assembleCanonicalPatch'), oldKeys.length + ' exports');

  // ── GATE OPEN: newest producer CREATE accepted+applied by the OLD processor ──
  // Canonical mint id: YYYYMMDD_HHMMSS_<CleanWell>_<6 lowercase-alnum>.
  const CREATE_ID = '20260827_150000_Gabriel1_a00001';
  const r1 = await callFn('ingestWbmPull', { packet: pull(CREATE_ID) }, drvTok);
  check('OPEN: real ingestWbmPull accepted (producer wrote incoming)', r1.status === 200 && r1.body?.result?.ok === true, JSON.stringify(r1.body));
  const p1key = r1.body?.result?.key || r1.body?.result?.packetId || CREATE_ID;
  const appliedOld = await waitProcessed(p1key);
  check('OPEN: the OLD processIncomingPull consumes the NEW producer packet (processed materialized)', appliedOld, String(p1key));
  const outAfter = Object.values((await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL).once('value')).val() || {})[0];
  check('OPEN: OLD pipeline path used — status written, NO chrono receipt/lock minted', !!outAfter && !(await anyChronoReceipt()) && !(await anyChronoLock()), JSON.stringify({ out: !!outAfter }));
  check('OPEN: NOT the 2^20 chrono sentinel — the OLD (non-coordinator) revision path was used', (await val('packets/incoming_version')) !== 7000 + 1048576, String(await val('packets/incoming_version')));

  // ── GATE OPEN: driver edit + dashboard admin edit accepted by OLD processEditRequest ──
  const drvEdit = { requestType: 'edit', wellName: WELL, originalPacketId: p1key, packetId: p1key, editEventId: 'editdrv000001', editedFields: ['bblsTaken'], bblsTaken: 150, tankLevelFeet: 14, idempotencyKey: 'editdrv000001', schemaVersion: 2, correctionCreatedAtUTC: '2026-08-27T16:00:00.000Z' };
  const re = await callFn('ingestWbmEdit', { packet: drvEdit }, drvTok);
  check('OPEN: real ingestWbmEdit accepted by producer', re.status === 200 && (re.body?.result?.ok === true), JSON.stringify(re.body));
  const ra = await callFn('adminSubmitPullEdit', { originalPacketId: p1key, wellName: WELL, tankTopInches: 170, bblsTaken: 152, wellDown: false }, admTok);
  check('OPEN: real adminSubmitPullEdit accepted by producer', ra.status === 200 && ra.body?.result?.ok === true, JSON.stringify(ra.body));
  // The OLD processEditRequest applies edits; confirm an edit landed on processed.
  const editApplied = await (async () => { const s = Date.now(); while (Date.now() - s < 12000) { const b = (await val(`packets/processed/${p1key}`))?.bblsTaken; if (b === 150 || b === 152) return true; await sleep(300); } return false; })();
  check('OPEN: OLD processEditRequest applied a producer edit to the processed row', editApplied, JSON.stringify((await val(`packets/processed/${p1key}`))?.bblsTaken));

  // ── CLOSE the gate: all three producers must stop; no new incoming appears ──
  await db.ref(GATE).set({ paused: true, reason: 'wbm_mutations_paused', at: Date.now(), by: 'deploy-op' });
  const keysBeforeClosed = new Set(await incomingKeys());
  const cPull = await callFn('ingestWbmPull', { packet: pull('20260827_160000_Gabriel1_blk002') }, drvTok);
  const cEdit = await callFn('ingestWbmEdit', { packet: { requestType: 'edit', wellName: WELL, originalPacketId: p1key, packetId: p1key, editEventId: 'editdrvblk002', editedFields: ['bblsTaken'], bblsTaken: 199, idempotencyKey: 'editdrvblk002', schemaVersion: 2, correctionCreatedAtUTC: '2026-08-27T17:00:00.000Z' } }, drvTok);
  const cAdm = await callFn('adminSubmitPullEdit', { originalPacketId: p1key, wellName: WELL, tankTopInches: 160, bblsTaken: 188, wellDown: false }, admTok);
  check('CLOSED: ingestWbmPull refused (retryable UNAVAILABLE)', cPull.status === 503 && cPull.body?.error?.status === 'UNAVAILABLE', JSON.stringify([cPull.status, cPull.body?.error?.status]));
  check('CLOSED: ingestWbmEdit refused (retryable UNAVAILABLE)', cEdit.status === 503 && cEdit.body?.error?.status === 'UNAVAILABLE', JSON.stringify([cEdit.status, cEdit.body?.error?.status]));
  check('CLOSED: adminSubmitPullEdit refused (retryable UNAVAILABLE)', cAdm.status === 503 && cAdm.body?.error?.status === 'UNAVAILABLE', JSON.stringify([cAdm.status, cAdm.body?.error?.status]));
  await sleep(2500);
  const keysAfterClosed = new Set(await incomingKeys());
  check('CLOSED: no NEW producer packet reached packets/incoming', [...keysAfterClosed].every((k) => keysBeforeClosed.has(k)), JSON.stringify([...keysAfterClosed].filter((k) => !keysBeforeClosed.has(k))));

  // ── Already-accepted OLD work drains after the gate closes ──
  // Newer than the create (15:00) so the OLD processor applies it rather than
  // stale-skipping — i.e. genuine already-accepted work that must still drain.
  const drainId = 'wbm_20260827_200000_Gabriel1_DRAIN';
  await db.ref(`packets/incoming/${drainId}`).set({ requestType: 'pull', wellName: WELL, packetId: drainId, idempotencyKey: 'd', dateTimeUTC: '2026-08-27T20:00:00.000Z', dateTime: '8/27 3PM', tankLevelFeet: 9, bblsTaken: 40, driverId: DRIVER_ID, driverName: 'D', ingestedAt: Date.now() });
  check('CLOSED: already-accepted incoming still DRAINS through the OLD processor', await waitProcessed(drainId));

  // Wait for incoming to fully drain (OLD consumers delete/replace processed keys).
  const drained = await (async () => { const s = Date.now(); while (Date.now() - s < 12000) { if ((await incomingKeys()).length === 0) return true; await sleep(300); } return (await incomingKeys()).length === 0; })();
  check('CLOSED: incoming fully drains (empty) with the gate shut', drained, JSON.stringify(await incomingKeys()));

  // ── OLD watchdog on the drained DB leaves NO new stranded work ──
  const beforeWd = { incoming: (await incomingKeys()).length, processedKeys: Object.keys((await val('packets/processed')) || {}).sort() };
  await oldLib.watchdogStrandedPackets.run({ scheduleTime: '2026-08-30T00:00:00Z' }); // REAL old watchdog against the emulator DB
  await sleep(1500);
  const afterWd = { incoming: (await incomingKeys()).length, processedKeys: Object.keys((await val('packets/processed')) || {}).sort() };
  check('DRAINED: OLD watchdog on empty incoming mints NO new stranded packet', afterWd.incoming === 0, JSON.stringify(afterWd.incoming));
  check('DRAINED: OLD watchdog does not re-key/duplicate any processed work', JSON.stringify(beforeWd.processedKeys) === JSON.stringify(afterWd.processedKeys), JSON.stringify({ b: beforeWd.processedKeys.length, a: afterWd.processedKeys.length }));

  // ── Horizon: OLD consumers are lock-free, so nothing owns an in-flight commit ──
  // (The 180s takeover horizon exists only for the NEW coordinator. The OLD
  //  generation writes sequentially with no lock/receipt, so once incoming is
  //  drained there is by construction no commit-owning invocation to wait out.)
  const horizonMs = Number(process.env.WB_HORIZON_MS || 8000); // representative window; invariant is structural
  const t0Keys = JSON.stringify((await incomingKeys()).sort());
  await sleep(horizonMs);
  const t1Keys = JSON.stringify((await incomingKeys()).sort());
  check('HORIZON: no coordinator lock is ever held by the OLD generation', !(await anyChronoLock()));
  check(`HORIZON: DB quiescent across the drain window (${horizonMs}ms) — no late old invocation resurfaces work`, t0Keys === t1Keys && (await incomingKeys()).length === 0, JSON.stringify([t0Keys, t1Keys]));

  console.log('\n=== STAGE-A MIXED GENERATION (real NEW producers + real OLD deployed consumers) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  console.log('\nNOTE: producers are this branch\'s gated build; consumers are the pre-chrono');
  console.log('deployed build (c7378d6). This is the exact live set during the Stage-A window.');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[stageA] fatal', e); process.exit(2); });
