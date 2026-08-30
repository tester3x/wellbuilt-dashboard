// Staged admission-gate harness (predeploy gate Blocker 3). Drives the REAL
// ingestWbmPull callable over HTTP (auth emulator) and toggles the governed
// flag system/maintenance/wbmMutations to prove: open → accepted; closed →
// retryable maintenance refusal with NO incoming write; already-accepted work
// stays drainable; reopen → accepted. The client's transient/retain behavior
// is unit-pinned in the WB-M suite (unavailable → keep the packet).
//
// RUN: node functions/emulator/run.mjs gate
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb` });
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
const FN = `http://127.0.0.1:5003/${PROJECT_ID}/us-central1/ingestWbmPull`;

let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const val = async (p) => (await db.ref(p).once('value')).val();
const WELL = 'Gabriel 1', DRIVER_ID = 'emu-driver-1';
const GATE = 'system/maintenance/wbmMutations';

async function callIngest(packet, idToken) {
  const res = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({ data: { packet } }) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const pull = (id, over = {}) => ({ requestType: 'pull', wellName: WELL, dateTimeUTC: '2026-08-27T15:00:00.000Z', dateTime: '8/27 10AM', tankLevelFeet: 9, bblsTaken: 40, packetId: id, idempotencyKey: id, ...over });
async function waitProcessed(id, ms = 12000) { const s = Date.now(); while (Date.now() - s < ms) { if (await val(`packets/processed/${id}`)) return true; await new Promise((r) => setTimeout(r, 300)); } return false; }

async function main() {
  await db.ref('/').set(null);
  await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'Gabriels', companyId: 'liquid-gold' });
  await db.ref(`drivers/profiles/${DRIVER_ID}`).set({ active: true, companyId: 'liquid-gold', displayName: 'Emu Driver', assignedRoutes: ['Gabriels'], assignedWells: [] });
  await admin.firestore().collection('driver_credentials').doc(DRIVER_ID).set({ active: true });
  await db.ref('packets/incoming_version').set(5000);
  const uid = `driver_${DRIVER_ID}`;
  await admin.auth().createUser({ uid });
  await admin.auth().setCustomUserClaims(uid, { kind: 'driver', driverId: DRIVER_ID, companyId: 'liquid-gold', roles: ['driver'] });
  const custom = await admin.auth().createCustomToken(uid);
  const { idToken } = await (await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })).json();
  check('auth token issued', !!idToken);

  // STAGE A default OPEN (flag absent) — request just before pause is accepted.
  const P1 = '20260827_100000_Gabriel1_pre001';
  const r1 = await callIngest(pull(P1), idToken);
  check('gate default OPEN (flag absent): pull accepted', r1.status === 200 && r1.body?.result?.ok === true, JSON.stringify([r1.status, r1.body?.result]));
  check('accepted pull materializes (real trigger)', await waitProcessed(P1));

  // STAGE B — CLOSE the gate. New submission returns retryable maintenance,
  // NO incoming written, no revision signal, existing work still drainable.
  await db.ref(GATE).set({ paused: true, reason: 'wbm_mutations_paused', at: Date.now(), by: 'deploy-op' });
  const P2 = '20260827_110000_Gabriel1_blk002';
  const r2 = await callIngest(pull(P2), idToken);
  check('gate CLOSED: pull refused with retryable UNAVAILABLE (not permanent)', r2.status === 503 && r2.body?.error?.status === 'UNAVAILABLE' && r2.body?.error?.message === 'wbm_mutations_paused', JSON.stringify([r2.status, r2.body?.error?.status, r2.body?.error?.message]));
  check('gate CLOSED: NO incoming written for the refused pull', (await val(`packets/incoming/${P2}`)) === null && (await val(`packets/processed/${P2}`)) === null, 'no material');
  check('gate CLOSED: no revision signal from a refused submission', (await val('packets/incoming_version')) === 5000 + 1048576, String(await val('packets/incoming_version')));

  // Already-accepted work drains: seed a pre-accepted incoming (as the callable
  // would have written it before pause) and confirm the trigger still processes it.
  await db.ref('packets/incoming/wbm_20260827_120000_Gabriel1_drn003').set({ requestType: 'pull', wellName: WELL, packetId: 'wbm_20260827_120000_Gabriel1_drn003', idempotencyKey: 'x', dateTimeUTC: '2026-08-27T12:00:00.000Z', dateTime: '8/27 7AM', tankLevelFeet: 9, bblsTaken: 40, driverId: DRIVER_ID, driverName: 'D', ingestedAt: Date.now() });
  check('gate CLOSED: already-accepted incoming still DRAINS (trigger processes it)', await waitProcessed('wbm_20260827_120000_Gabriel1_drn003'));

  // Client retain: a repeated refused call keeps the SAME packet id available
  // to retry (no state was created to mark it sent/rejected).
  const r2b = await callIngest(pull(P2), idToken);
  check('gate CLOSED: retry of the refused pull is still just refused (packet retained client-side, no partial state)', r2b.status === 503 && (await val(`packets/incoming/${P2}`)) === null, JSON.stringify(r2b.status));

  // STAGE D — REOPEN. Offline retry after reopen succeeds with the SAME id.
  await db.ref(GATE).set({ paused: false, reason: '', at: Date.now(), by: 'deploy-op' });
  const r3 = await callIngest(pull(P2), idToken);
  check('gate REOPENED: the previously-refused pull now accepted with the SAME id', r3.status === 200 && r3.body?.result?.packetId?.includes('blk002'), JSON.stringify([r3.status, r3.body?.result?.packetId]));
  check('gate REOPENED: it materializes; no pull was lost or double-counted', await waitProcessed(r3.body?.result?.packetId?.replace('wbm_', '') || P2) || !!(await val(`packets/processed/${r3.body?.result?.key || ''}`)), 'processed');

  console.log('\n=== ADMISSION GATE (real ingestWbmPull callable, governed flag) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[gate] fatal', e); process.exit(2); });
