// Real adminSubmitPullEdit callable through the emulator (predeploy gate Rev-3
// items 1-2). Exercises the ACTUAL exported callable (ported to this branch)
// with a manageDrivers-authorized caller: admission-gate behavior, the exact
// legacy edit record, distinct-key dedupe, different-material evidencing, and
// that authorization failures stay authorization failures.
//
// RUN: node functions/emulator/run.mjs admingate
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb` });
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
const FN = `http://127.0.0.1:5003/${PROJECT_ID}/us-central1/adminSubmitPullEdit`;

let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const val = async (p) => (await db.ref(p).once('value')).val();
const WELL = 'Gabriel 1', GATE = 'system/maintenance/wbmMutations';

async function callEdit(data, idToken) {
  const res = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
async function tokenFor(uid) {
  await admin.auth().createUser({ uid }).catch(() => {});
  const custom = await admin.auth().createCustomToken(uid);
  const j = await (await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })).json();
  return j.idToken;
}
async function seedPull(id, dtUtc, bbls, top) {
  await db.ref(`packets/processed/${id}`).set({ packetId: id, wellName: WELL, companyId: 'liquid-gold', dateTimeUTC: dtUtc, dateTime: new Date(dtUtc).toISOString(), bblsTaken: bbls, tankTopInches: top, tankLevelFeet: top / 12, tankAfterInches: top - (bbls / 20) * 12, driverName: 'L', driverId: 'd0', processedAt: new Date().toISOString() });
}
async function waitConsumed(pred, ms = 12000) { const s = Date.now(); while (Date.now() - s < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 300)); } return false; }
const editIncomingKeys = async () => Object.keys((await val('packets/incoming')) || {}).filter((k) => k.startsWith('edit_'));

async function main() {
  await db.ref('/').set(null);
  await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'Gabriels', companyId: 'liquid-gold' });
  await db.ref('packets/incoming_version').set(3000);
  // Platform-admin caller (RTDB users doc, no companyId → isPlatformAdmin).
  const adminUid = 'dash-admin-1';
  await db.ref(`users/${adminUid}`).set({ role: 'admin', displayName: 'Dash Admin' });
  const idToken = await tokenFor(adminUid);
  check('admin caller token issued', !!idToken);

  const editReq = (over = {}) => ({ originalPacketId: 'p1', wellName: WELL, tankTopInches: 168, bblsTaken: 150, wellDown: false, ...over });

  // 1) GATE MISSING → open → normal legacy edit accepted + applied.
  await seedPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const r1 = await callEdit(editReq(), idToken);
  check('gate MISSING → open: adminSubmitPullEdit accepted', r1.status === 200 && r1.body?.result?.ok === true && typeof r1.body?.result?.packetId === 'string', JSON.stringify([r1.status, r1.body?.result]));
  check('accepted edit APPLIES through the real trigger (bbls 150)', await waitConsumed(async () => (await val('packets/processed/p1'))?.bblsTaken === 150));

  // 2) GATE EXPLICITLY OPEN → accepted.
  await db.ref(GATE).set({ paused: false });
  await db.ref('/').set(null); await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'Gabriels', companyId: 'liquid-gold' }); await db.ref('packets/incoming_version').set(3000); await db.ref(`users/${adminUid}`).set({ role: 'admin', displayName: 'Dash Admin' }); await seedPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const r2 = await callEdit(editReq({ bblsTaken: 151 }), idToken);
  check('gate OPEN (explicit false): accepted', r2.status === 200 && r2.body?.result?.ok === true);
  await waitConsumed(async () => (await val('packets/processed/p1'))?.bblsTaken === 151);

  // 3) GATE CLOSED → retryable maintenance refusal; NO edit incoming; no state change.
  await db.ref(GATE).set({ paused: true, reason: 'wbm_mutations_paused' });
  const legBefore = await val('packets/incoming_version');
  const bblsBefore = (await val('packets/processed/p1'))?.bblsTaken;
  const r3 = await callEdit(editReq({ bblsTaken: 199 }), idToken);
  check('gate CLOSED → retryable UNAVAILABLE (not permanent, not auth)', r3.status === 503 && r3.body?.error?.status === 'UNAVAILABLE' && r3.body?.error?.message === 'wbm_mutations_paused', JSON.stringify([r3.status, r3.body?.error?.status]));
  await new Promise((r) => setTimeout(r, 2500));
  check('gate CLOSED: NO edit_ incoming record written', (await editIncomingKeys()).length === 0, JSON.stringify(await editIncomingKeys()));
  check('gate CLOSED: neither revision bumped', (await val('packets/incoming_version')) === legBefore, String(await val('packets/incoming_version')));
  check('gate CLOSED: no receipt created for a refused edit', Object.keys((await val(`wells/${WELL}/chronoReceipts`)) || {}).every((k) => !k.includes('_199_') ) && (await val('packets/processed/p1'))?.bblsTaken === bblsBefore, 'unchanged');
  check('gate CLOSED: processed/status unchanged (edit did not apply)', (await val('packets/processed/p1'))?.bblsTaken === bblsBefore, JSON.stringify(bblsBefore));

  // 4) REOPEN → same request accepted.
  await db.ref(GATE).set({ paused: false });
  const r4 = await callEdit(editReq({ bblsTaken: 199 }), idToken);
  check('gate REOPENED: the same edit now accepted', r4.status === 200 && r4.body?.result?.ok === true);
  check('reopened edit applies (bbls 199)', await waitConsumed(async () => (await val('packets/processed/p1'))?.bblsTaken === 199));

  // 5) EQUIVALENT retry under a DIFFERENT edit_<Date.now()>_<well> key dedupes.
  await db.ref('/').set(null); await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'Gabriels', companyId: 'liquid-gold' }); await db.ref('packets/incoming_version').set(3000); await db.ref(`users/${adminUid}`).set({ role: 'admin', displayName: 'Dash Admin' }); await seedPull('p1', '2026-08-27T15:00:00.000Z', 140, 168); await db.ref(GATE).set({ paused: false });
  const a = await callEdit(editReq({ bblsTaken: 155 }), idToken); await waitConsumed(async () => (await val('packets/processed/p1'))?.bblsTaken === 155);
  const legA = await val('packets/incoming_version');
  const b = await callEdit(editReq({ bblsTaken: 155 }), idToken); await new Promise((r) => setTimeout(r, 4000));
  check('distinct callable keys + equivalent material: dedupes (editCount 1, no extra bump)', (await val('packets/processed/p1'))?.editCount === 1 && (await val('packets/incoming_version')) === legA, JSON.stringify({ cnt: (await val('packets/processed/p1'))?.editCount, a: r1.body?.result?.packetId !== b.body?.result?.packetId }));
  check('the two callable invocations minted DIFFERENT incoming keys (proving dedupe is content-based)', a.body?.result?.packetId !== b.body?.result?.packetId, JSON.stringify([a.body?.result?.packetId, b.body?.result?.packetId]));

  // 6) DIFFERENT final material → both edit events evidenced.
  const c = await callEdit(editReq({ bblsTaken: 145 }), idToken); await waitConsumed(async () => (await val('packets/processed/p1'))?.bblsTaken === 145);
  check('different material under a new key: BOTH edit events evidenced (final=145)', Object.keys((await val('packets/editHistory/p1')) || {}).length === 2 && (await val('packets/processed/p1'))?.bblsTaken === 145, JSON.stringify(Object.keys((await val('packets/editHistory/p1')) || {}).length));

  // 7) AUTHORIZATION failure stays an authorization failure (not maintenance).
  await db.ref(GATE).set({ paused: true }); // even paused, auth is checked FIRST
  const noAuth = await callEdit(editReq(), undefined);
  check('unauthenticated edit → UNAUTHENTICATED (auth precedes the gate)', noAuth.status === 401 && noAuth.body?.error?.status === 'UNAUTHENTICATED', JSON.stringify([noAuth.status, noAuth.body?.error?.status]));
  const badUid = await tokenFor('nobody-uid'); // no users/ doc, no claims → not manageDrivers
  const notAdmin = await callEdit(editReq(), badUid);
  check('non-manageDrivers caller → permission/unauthenticated, NOT maintenance', (notAdmin.status === 403 || notAdmin.status === 401) && notAdmin.body?.error?.status !== 'UNAVAILABLE', JSON.stringify([notAdmin.status, notAdmin.body?.error?.status]));

  console.log('\n=== ADMIN GATE (real adminSubmitPullEdit callable) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[adminGate] fatal', e); process.exit(2); });
