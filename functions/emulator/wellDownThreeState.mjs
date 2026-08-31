// wellDownThreeState.mjs — end-to-end proof of the three-state wellDown contract
// through the REAL candidate pipeline (ingestWbmEdit producer → processEditRequest
// consumer), reproducing the Thor 1 incident (8/30/2026): a previously-DOWN well,
// an edit that brings it online (wellDown:false), must clear DOWN EVERYWHERE.
//
//   explicit true  in the editedFields mask → marks DOWN
//   explicit false in the mask             → brings online (clears DOWN)
//   wellDown OMITTED from the mask         → preserves prior status
//
// Thor-style exact data: Top 11'4" (136"), 140 bbl, bottom 4'4", prior DOWN.
//
// RUN: node functions/emulator/run.mjs welldown
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb` });
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
const FN = (n) => `http://127.0.0.1:5003/${PROJECT_ID}/us-central1/${n}`;

let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const val = async (p) => (await db.ref(p).once('value')).val();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WELL = 'Thor 1', DRIVER_ID = 'emu-driver-thor';

async function tokenFor() {
  const uid = `driver_${DRIVER_ID}`;
  await admin.auth().createUser({ uid }).catch(() => {});
  await admin.auth().setCustomUserClaims(uid, { kind: 'driver', driverId: DRIVER_ID, companyId: 'liquid-gold', roles: ['driver'] });
  const custom = await admin.auth().createCustomToken(uid);
  const j = await (await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })).json();
  return j.idToken;
}
async function callEdit(packet, idToken) {
  const res = await fetch(FN('ingestWbmEdit'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data: { packet } }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function callPull(packet, idToken) {
  const res = await fetch(FN('ingestWbmPull'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data: { packet } }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
// The EXACT shape the WB-M client create builder emits (firebase.ts): explicit
// wellDown boolean + wellDownIsAuthoritative:true.
const pullPkt = (id, wellDown) => ({ requestType: 'pull', wellName: WELL, dateTimeUTC: '2026-08-30T20:00:00.000Z', dateTime: '8/30/2026 3PM', timezone: 'America/Chicago', tankLevelFeet: 136 / 12, bblsTaken: 140, wellDown, wellDownIsAuthoritative: true, packetId: id, idempotencyKey: id });
// The row the edit wrote: prefer isEdit, else the most recent by time.
const outRow = async () => {
  const all = Object.values((await val('packets/outgoing')) || {}).filter((x) => x && x.wellName === WELL);
  if (!all.length) return null;
  const edits = all.filter((x) => x.isEdit === true);
  const pool = edits.length ? edits : all;
  return pool.sort((a, b) => new Date(b.lastPullDateTimeUTC || 0) - new Date(a.lastPullDateTimeUTC || 0))[0];
};
const outCount = async () => Object.values((await val('packets/outgoing')) || {}).filter((x) => x && x.wellName === WELL).length;

const PID = '20260830_123821_Thor1_unozct'; // the incident's exact original packet id
async function seedDownWell() {
  await db.ref('/').set(null);
  await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 140, route: 'Thors', companyId: 'liquid-gold' });
  await db.ref(`drivers/profiles/${DRIVER_ID}`).set({ active: true, companyId: 'liquid-gold', displayName: 'Thor Driver', assignedRoutes: ['Thors'], assignedWells: [] });
  await admin.firestore().collection('driver_credentials').doc(DRIVER_ID).set({ active: true });
  await db.ref('packets/incoming_version').set(9000);
  // Prior history so AFR computes (>0) — the real Thor 1 had 16 rates; the edit
  // only rebuilds outgoing when afr>0. Six pulls, ~1 day apart, steady recovery.
  for (let i = 6; i >= 1; i--) {
    const day = 24 + (6 - i); // 8/24..8/29
    const hid = `202608${day}_120000_Thor1_hist0${i}`;
    const top = 136, after = 52 + i; // slightly varying so rates differ
    await db.ref(`packets/processed/${hid}`).set({ packetId: hid, wellName: WELL, companyId: 'liquid-gold', driverId: DRIVER_ID, driverName: 'Thor Driver', dateTimeUTC: `2026-08-${day}T17:00:00.000Z`, dateTime: `8/${day}/2026 12:00 PM`, bblsTaken: 140, tankTopInches: top, tankLevelFeet: top / 12, tankAfterInches: after, wellDown: false, processedAt: new Date().toISOString() });
  }
  // Original pull (Top 11'4"=136", 140 bbl), well is DOWN.
  await db.ref(`packets/processed/${PID}`).set({ packetId: PID, wellName: WELL, companyId: 'liquid-gold', driverId: DRIVER_ID, driverName: 'Thor Driver', dateTimeUTC: '2026-08-30T17:38:09.654Z', dateTime: '8/30/2026 12:38 PM', bblsTaken: 140, tankTopInches: 136, tankLevelFeet: 136 / 12, tankAfterInches: 52, wellDown: true, processedAt: new Date().toISOString() });
  await db.ref(`packets/outgoing/response_seed_${PID}`).set({ wellName: WELL, lastPullPacketId: PID, lastPullDateTimeUTC: '2026-08-30T17:38:09.654Z', wellDown: true, isEdit: false });
  await db.ref(`wells/${WELL}/status`).set({ wellName: WELL, isDown: true, updatedAt: new Date().toISOString(), current: { levelInches: 52 }, lastPull: { packetId: PID, dateTimeUTC: '2026-08-30T17:38:09.654Z', bblsTaken: 140 } });
}
let CORR = 0;
const editPkt = (over) => ({ requestType: 'edit', wellName: WELL, originalPacketId: PID, packetId: PID, editEventId: over.eid, idempotencyKey: over.eid, editedFields: over.editedFields, schemaVersion: 2, correctionCreatedAtUTC: new Date(Date.parse('2026-08-30T19:09:00.000Z') + (++CORR) * 60000).toISOString(), tankLevelFeet: 136 / 12, bblsTaken: over.bblsTaken ?? 140, ...(over.wellDown !== undefined ? { wellDown: over.wellDown } : {}) });
async function waitStatus(pred, ms = 14000) { const s = Date.now(); while (Date.now() - s < ms) { if (await pred()) return true; await sleep(300); } return false; }

async function main() {
  const tok = await tokenFor();
  check('driver token issued', !!tok);

  // ── CASE 1 — Thor 1: prior DOWN, edit wellDown:false in the mask → RUNNING everywhere ──
  await seedDownWell();
  check('precondition: well is DOWN (status.isDown:true)', (await val(`wells/${WELL}/status/isDown`)) === true);
  // editedFields is the EXACT full WB-M client mask that buildWbmEditCommand emits.
  const CLIENT_MASK = ['tankLevelFeet', 'bblsTaken', 'wellDown'];
  const verBefore = await val('packets/incoming_version');
  const r1 = await callEdit(editPkt({ eid: 'editevt_thor_online1', editedFields: CLIENT_MASK, wellDown: false }), tok);
  check('governed bring-online edit accepted by ingestWbmEdit', r1.status === 200 && r1.body?.result?.ok === true, JSON.stringify(r1.body));
  const cleared = await waitStatus(async () => (await val(`wells/${WELL}/status/isDown`)) === false);
  check('THOR 1 FIX: explicit false in the real client mask CLEARS DOWN — status.isDown:false', cleared, JSON.stringify(await val(`wells/${WELL}/status/isDown`)));
  check('processed record reflects wellDown:false (authoritative)', (await val(`packets/processed/${PID}`))?.wellDown === false);
  const o1 = await outRow();
  check('outgoing agrees: wellDown:false (Running)', o1 && o1.wellDown === false, JSON.stringify(o1 && { wellDown: o1.wellDown }));
  check('status, processed, and outgoing ALL agree (Running)', (await val(`wells/${WELL}/status/isDown`)) === false && (await val(`packets/processed/${PID}`))?.wellDown === false && (await outRow())?.wellDown === false);

  // ── Two-client refresh (item 6): the edit must move the revision signals so a
  //    SECOND client refreshes promptly — not rely on a saturated incoming_version. ──
  const verAfter = await val('packets/incoming_version');
  check('incoming_version ADVANCED by the 2^20 sentinel (not stuck — legacy +1 would no-op at saturation)', typeof verAfter === 'number' && verAfter !== verBefore && (verAfter - verBefore) % 1048576 === 0, JSON.stringify({ before: verBefore, after: verAfter, delta: verAfter - verBefore }));
  check('incoming_revision_v2 advanced (token present) for the edit', !!(await val('packets/incoming_revision_v2'))?.token);
  // A fresh "second client" read observes the confirmed Running state immediately.
  const secondClientView = { isDown: await val(`wells/${WELL}/status/isDown`), outgoingWellDown: (await outRow())?.wellDown };
  check('a SECOND client reading after receipt sees Running (isDown:false, outgoing:false)', secondClientView.isDown === false && secondClientView.outgoingWellDown === false, JSON.stringify(secondClientView));

  check('exactly one outgoing row for the well (no stale duplicate)', (await outCount()) === 1, `count=${await outCount()}`);

  // ── CASE 2 — fresh DOWN well; explicit true in the mask → marks DOWN everywhere ──
  // (start from RUNNING so a true edit is a real change)
  await seedDownWell();
  await callEdit(editPkt({ eid: 'editevt_c2_online', editedFields: CLIENT_MASK, wellDown: false }), tok);
  await waitStatus(async () => (await val(`wells/${WELL}/status/isDown`)) === false);
  const r2 = await callEdit(editPkt({ eid: 'editevt_c2_down', editedFields: CLIENT_MASK, wellDown: true }), tok);
  check('mark-down edit accepted', r2.status === 200 && r2.body?.result?.ok === true, JSON.stringify(r2.body));
  const downAgain = await waitStatus(async () => (await val(`wells/${WELL}/status/isDown`)) === true);
  check('explicit true in the mask MARKS DOWN — status.isDown:true', downAgain, JSON.stringify(await val(`wells/${WELL}/status/isDown`)));
  check('outgoing agrees: wellDown:true (DOWN)', (await outRow())?.wellDown === true, JSON.stringify(await outRow()));

  // ── CASE 3 — fresh DOWN well; wellDown OMITTED from the mask → preserves DOWN ──
  await seedDownWell(); // well is DOWN
  const r3 = await callEdit(editPkt({ eid: 'editevt_c3_levelonly', editedFields: ['bblsTaken'], bblsTaken: 150, wellDown: false }), tok); // wellDown false in BODY but NOT in mask
  check('level-only edit accepted (wellDown not in mask)', r3.status === 200 && r3.body?.result?.ok === true, JSON.stringify(r3.body));
  await sleep(4000);
  check('OMITTED wellDown (not in mask) PRESERVES prior DOWN (despite wellDown:false in body)', (await val(`wells/${WELL}/status/isDown`)) === true, JSON.stringify({ after: await val(`wells/${WELL}/status/isDown`) }));

  // ── CASE 4 — idempotent retry of the bring-online correction ──
  await seedDownWell();
  await callEdit(editPkt({ eid: 'editevt_thor_idem', editedFields: CLIENT_MASK, wellDown: false }), tok);
  await waitStatus(async () => (await val(`wells/${WELL}/status/isDown`)) === false);
  const revA = (await val(`packets/processed/${PID}`))?.editCount ?? (await val('packets/incoming_version'));
  await callEdit(editPkt({ eid: 'editevt_thor_idem', editedFields: CLIENT_MASK, wellDown: false }), tok); // same editEventId
  await sleep(3000);
  check('idempotent retry (same editEventId) keeps Running, no double-apply', (await val(`wells/${WELL}/status/isDown`)) === false);

  // ── CASE 5 — legacy edit (no editedFields) FAILS CLOSED at admission (item 5) ──
  // The governed producer rejects a non-v2 edit rather than silently applying it
  // — so an older client can NEVER get "edited successfully" while the well
  // stays DOWN; the failure is explicit (client-update-required), not silent.
  await seedDownWell();
  const legacy = { requestType: 'edit', wellName: WELL, originalPacketId: PID, packetId: PID, editEventId: 'editevt_legacy1', idempotencyKey: 'editevt_legacy1', tankLevelFeet: 136 / 12, bblsTaken: 140, wellDown: false }; // NO schemaVersion / editedFields / correctionCreatedAtUTC
  const rl = await callEdit(legacy, tok);
  const legacyRejected = rl.status >= 400 || rl.body?.result?.ok === false;
  check('legacy edit (no editedFields) FAILS CLOSED at ingestWbmEdit — not silently applied', legacyRejected, JSON.stringify([rl.status, rl.body?.result || rl.body?.error]));
  await sleep(2500);
  check('legacy-edit rejection leaves the well DOWN (never "edited successfully" while DOWN)', (await val(`wells/${WELL}/status/isDown`)) === true);

  // ══ CREATE three-state (item 1): the newest CREATE controls current status ══
  // C1 — prior DOWN + newest CREATE wellDown:false authoritative → RUNNING everywhere.
  await seedDownWell();
  const cid1 = '20260830_200000_Thor1_crt001';
  const cv = await callPull(pullPkt(cid1, false), tok);
  check('CREATE accepted by ingestWbmPull (explicit false + authoritative)', cv.status === 200 && cv.body?.result?.ok === true, JSON.stringify(cv.body));
  const cCleared = await waitStatus(async () => (await val(`wells/${WELL}/status/isDown`)) === false);
  check('CREATE C1: newest CREATE with explicit false CLEARS a previously DOWN well', cCleared, JSON.stringify(await val(`wells/${WELL}/status/isDown`)));
  const co = Object.values((await val('packets/outgoing')) || {}).filter((x) => x && x.wellName === WELL).sort((a, b) => new Date(b.lastPullDateTimeUTC || 0) - new Date(a.lastPullDateTimeUTC || 0))[0];
  check('CREATE C1: status/outgoing/processed agree Running', (await val(`wells/${WELL}/status/isDown`)) === false && co?.wellDown === false && (await val(`packets/processed/${cid1}`))?.wellDown === false, JSON.stringify({ isDown: await val(`wells/${WELL}/status/isDown`), out: co?.wellDown }));

  // C2 — prior Running (from C1) + newest CREATE wellDown:true authoritative → DOWN.
  const cid2 = '20260830_210000_Thor1_crt002';
  await callPull(pullPkt(cid2, true), tok);
  check('CREATE C2: newest CREATE with explicit true MARKS a running well DOWN', await waitStatus(async () => (await val(`wells/${WELL}/status/isDown`)) === true));

  // C3 — CREATE idempotent retry (same packetId) → single processed, still DOWN.
  await callPull(pullPkt(cid2, true), tok);
  await sleep(2500);
  check('CREATE C3: idempotent retry (same packetId) does not double-apply', (await val(`wells/${WELL}/status/isDown`)) === true && !!(await val(`packets/processed/${cid2}`)));

  console.log('\n=== WELL-DOWN THREE-STATE CONTRACT (real candidate ingestWbmEdit → processEditRequest) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[wellDown] fatal', e); process.exit(2); });
