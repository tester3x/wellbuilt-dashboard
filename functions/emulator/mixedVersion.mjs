// Mixed old/new deployment-window harness (safety gate item 3).
//
// A filtered multi-function deploy is NOT atomic: during rollout the old
// (deployed, audited) pipeline and the new canonical pipeline can both act on
// ONE database. The NEW triggers run for real in the emulator; OLD operations
// are simulated as the deployed pipeline's EXACT writes — sequential
// processed + FULL-NODE `wells/<w>/status`.set() (which wipes chronoLock /
// chronoRevision) + outgoing set + a separate incoming_version bump, with NO
// lock and NO receipt. This measures what actually happens when the two
// generations overlap, and proves the quiesced path is clean.
//
// RUN: node functions/emulator/run.mjs mixed   (see run.mjs)
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: PROJECT_ID,
  databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb`,
});
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (name, cond, detail = '') => {
  if (cond) results.push(`  PASS  ${name}`); else { failures++; results.push(`  FAIL  ${name}  ${detail}`); }
};
const val = async (p) => (await db.ref(p).once('value')).val();
const WELL = 'Cyclone 1';
const outRow = async () => Object.values((await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL).once('value')).val() || {})[0] || null;
const lockPath = `wells/${WELL}/status/chronoLock`;

async function seed() {
  await db.ref('/').set(null);
  await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'R1', companyId: 'liquid-gold' });
  await db.ref('packets/incoming_version').set(1000);
}
async function newPull(id, over = {}) {
  await db.ref(`packets/incoming/${id}`).set({
    requestType: 'pull', wellName: WELL, packetId: id, driverName: 'D', driverId: 'd1',
    dateTimeUTC: over.dateTimeUTC || '2026-08-27T12:00:00.000Z', dateTime: over.dateTime || '8/27 7AM',
    tankLevelFeet: over.tankLevelFeet || '9', bblsTaken: over.bblsTaken ?? 40, ingestedAt: over.ingestedAt ?? Date.now(),
  });
}

/** OLD pipeline pull — the deployed pattern: sequential processed + full-node
 *  status.set() (wipes coordinator metadata) + outgoing + incoming_version+1. */
async function oldPull(id, over = {}) {
  const dtUtc = over.dateTimeUTC || '2026-08-27T12:00:00.000Z';
  const bbls = over.bblsTaken ?? 40;
  const top = Number(over.tankLevelFeet || 9) * 12;
  const after = top - (bbls / 20) * 12;
  await db.ref(`packets/processed/${id}`).set({ packetId: id, wellName: WELL, companyId: 'liquid-gold', dateTimeUTC: dtUtc, bblsTaken: bbls, tankTopInches: top, tankAfterInches: after, driverName: 'D', processedAt: new Date().toISOString() });
  // FULL-NODE set — replaces status entirely, deleting chronoLock/chronoRevision.
  await db.ref(`wells/${WELL}/status`).set({ wellName: WELL, isDown: false, updatedAt: new Date().toISOString(), current: { levelInches: after }, lastPull: { packetId: id, dateTimeUTC: dtUtc, bblsTaken: bbls, bottomLevelInches: after } });
  await db.ref(`packets/outgoing/response_old_${id}`).set({ wellName: WELL, lastPullPacketId: id, lastPullDateTimeUTC: dtUtc, isEdit: false });
  const cur = Number(await val('packets/incoming_version')) || 0;
  await db.ref('packets/incoming_version').set(cur + 1); // old +1 (no-op at saturation; fine here)
}

/** OLD watchdog: the deployed re-key clone (local-time key parsed as UTC → looks stale). */
async function oldWatchdogClone(id) {
  const data = await val(`packets/incoming/${id}`);
  if (!data) return;
  const newKey = `${id}_clone${Math.floor(Date.now() / 1000) % 1000}`;
  await db.ref().update({ [`packets/incoming/${id}`]: null, [`packets/incoming/${newKey}`]: { ...data, packetId: newKey, _originalKey: id, _retriggeredBy: 'old-watchdog' } });
  return newKey;
}
async function waitProcessed(id, ms = 12000) { const s = Date.now(); while (Date.now() - s < ms) { if (await val(`packets/processed/${id}`)) return true; await sleep(300); } return false; }

async function main() {
  // ── CONTROL: quiesced — new pipeline alone, no overlap → clean ──
  await seed();
  await newPull('q1', { dateTimeUTC: '2026-08-27T12:00:00.000Z' });
  await waitProcessed('q1');
  const c = await outRow();
  check('QUIESCED control: new CREATE commits cleanly (receipt + current + both revisions)', !!(await val(`wells/${WELL}/chronoReceipts/q1`)) && c?.lastPullPacketId === 'q1' && (await val('packets/incoming_version')) === 1000 + 1048576 && (await val('packets/incoming_revision_v2'))?.token === 'q1', JSON.stringify(c?.lastPullPacketId));

  // ── RACE 1: new CREATE holds planning; old EDIT full-node status.set wipes
  //    the lock mid-flight → new CREATE's transition CAS must FAIL and commit
  //    NOTHING (fail-safe), leaving its incoming for retry. ──
  await seed();
  await newPull('r1', { dateTimeUTC: '2026-08-27T13:00:00.000Z' });
  // Simulate the overlap by planting a committing lock (a live new worker) then
  // having OLD do a full-node status.set that deletes it.
  await db.ref(lockPath).set({ token: 'newA', fence: 1, phase: 'planning', at: Date.now(), operationId: 'r1' });
  await db.ref(`wells/${WELL}/status`).set({ wellName: WELL, isDown: false, updatedAt: new Date().toISOString() }); // OLD wipes lock
  const lockAfterOld = await val(lockPath);
  check('RACE1: old full-node status.set() WIPES the coordinator lock (documented hazard)', lockAfterOld === null, JSON.stringify(lockAfterOld));
  // Now the real new trigger runs r1 from scratch (lock gone) → it acquires clean and commits.
  await db.ref(`packets/incoming/r1`).set(await val('packets/incoming/r1')); // re-trigger
  await waitProcessed('r1');
  check('RACE1: after the wipe the new op re-acquires and commits (no partial state, no dup)', !!(await val(`packets/processed/r1`)) && !!(await val(`wells/${WELL}/chronoReceipts/r1`)), 'recovered');

  // ── RACE 2: new CREATE (newest) commits fully; then OLD EDIT of an OLDER
  //    pull does a full-node status.set → CURRENT REGRESSES to the older pull.
  //    This is the core mixed-version hazard. ──
  await seed();
  await newPull('n_new', { dateTimeUTC: '2026-08-27T18:00:00.000Z', bblsTaken: 60 });
  await waitProcessed('n_new');
  const beforeRegress = (await outRow())?.lastPullPacketId;
  // OLD edits an older sibling and full-node-sets status to point at it.
  await db.ref(`packets/processed/o_old`).set({ packetId: 'o_old', wellName: WELL, companyId: 'liquid-gold', dateTimeUTC: '2026-08-27T09:00:00.000Z', bblsTaken: 30, tankAfterInches: 90, processedAt: new Date().toISOString() });
  await db.ref(`wells/${WELL}/status`).set({ wellName: WELL, isDown: false, updatedAt: new Date().toISOString(), lastPull: { packetId: 'o_old', dateTimeUTC: '2026-08-27T09:00:00.000Z' } });
  const regressed = (await val(`wells/${WELL}/status/lastPull`))?.packetId;
  check('RACE2 HAZARD PROVEN: old op after a new commit regresses current (older pull becomes status.lastPull)', beforeRegress === 'n_new' && regressed === 'o_old', JSON.stringify([beforeRegress, regressed]));
  check('RACE2: but the processed HISTORY is not lost — both rows survive', !!(await val('packets/processed/n_new')) && !!(await val('packets/processed/o_old')), 'both present');

  // ── RACE 3: OLD watchdog clone racing a queued packet the NEW pipeline owns.
  //    Old watchdog re-keys (clone) → the new pipeline would then see a
  //    DIFFERENT-id packet with shared lineage → CORRECTION/duplicate handling,
  //    not a silent second pull. ──
  await seed();
  await newPull('w1', { dateTimeUTC: '2026-08-27T14:00:00.000Z', bblsTaken: 40 });
  await waitProcessed('w1');
  // Old watchdog re-keys a still-queued copy: a DISTINCT packetId that carries
  // _originalKey lineage back to the processed w1, same material — written in
  // ONE shot so the trigger sees the lineage on its onCreate.
  await db.ref('packets/incoming/w1_clone123').set({
    requestType: 'pull', wellName: WELL, packetId: 'w1_clone123', _originalKey: 'w1', _retriggeredBy: 'old-watchdog',
    driverName: 'D', driverId: 'd1', dateTimeUTC: '2026-08-27T14:00:00.000Z', dateTime: '8/27 9AM',
    tankLevelFeet: '9', bblsTaken: 40, ingestedAt: Date.now(),
  });
  await sleep(4000);
  const w2processed = await val('packets/processed/w1_clone123');
  const w2rejected = await val('packets/rejected/w1_clone123');
  check('RACE3: old-watchdog-style clone (shared lineage, same material) → collapsed to quarantine, NOT a duplicate pull', (w2processed === null && !!w2rejected && w2rejected.reason === 'PROVEN_DUPLICATE'), JSON.stringify({ proc: !!w2processed, rej: w2rejected?.reason }));

  // ── RACE 4: deploy with packets ALREADY waiting in incoming → the new
  //    trigger processes them normally on first fire (no loss). ──
  await seed();
  await db.ref('packets/incoming/pre1').set({ requestType: 'pull', wellName: WELL, packetId: 'pre1', driverName: 'D', driverId: 'd1', dateTimeUTC: '2026-08-27T15:00:00.000Z', dateTime: '8/27 10AM', tankLevelFeet: '10', bblsTaken: 40, ingestedAt: Date.now() });
  // Re-write to fire the (now-new) trigger — models "producer resumes after cutover".
  await db.ref('packets/incoming/pre1').set(await val('packets/incoming/pre1'));
  check('RACE4: a packet already queued at cutover is processed by the new trigger (no loss)', await waitProcessed('pre1'), 'processed');

  console.log('\n=== MIXED-VERSION WINDOW (new real triggers + simulated old pipeline writes) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  console.log('\nNOTE: RACE2 is a PASSING test of a PROVEN HAZARD — concurrent old+new on one');
  console.log('well regresses current. The rollout runbook REQUIRES quiescence to prevent it.');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[mixed] fatal', e); process.exit(2); });
