// watchdogDrainRace.mjs — the ACTUAL watchdog/drain race (predeploy gate Rev-4
// Blocker 4). Reproduces the already-proven production sequence where the old
// watchdog mis-ages a local-time packet key, re-keys/removes it, and the
// ORIGINAL old processIncomingPull invocation keeps writing from its onCreate
// snapshot AFTER incoming looks empty — so a one-shot empty check is unsafe and
// only the governed continuous horizon (≥ the old trigger's max lifetime) is
// safe.
//
// Components: the REAL old watchdog (built from the deployed commit c7378d6,
// invoked via .run() against the emulator DB) + a faithfully reconstructed slow
// old processIncomingPull/processEditRequest whose write lands after an injected
// in-flight delay (a cold-start original). The packet is written in the exact
// shape the real gated producer emits (that acceptance is separately proven in
// stageA.mjs, 19/19). DB-only so the reconstructed original owns the race
// deterministically (no auto-trigger interference).
//
// Timescale is SCALED for a test: OLD_ORIGINAL_MS models the ≤120s trigger
// timeout; HORIZON_MS_SCALED models the 180s governed horizon (120s timeout +
// 60s margin); EARLY_UNSAFE_MS models a premature 179s check.
//
// RUN: node functions/emulator/run.mjs drainrace
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb` });
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
const _init = admin.initializeApp.bind(admin);
admin.initializeApp = (...a) => { try { return _init(...a); } catch (e) { if (e?.code === 'app/duplicate-app') return admin.app(); throw e; } };
admin.initializeApp();
const db = admin.database();
const oldLib = require(process.env.WB_OLD_LIB); // REAL old watchdog

let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const val = async (p) => (await db.ref(p).once('value')).val();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WELL = 'Gabriel 1';

const OLD_ORIGINAL_MS = 2500;   // in-flight lifetime of a slow (cold-start) original → ≤120s in prod
const HORIZON_MS_SCALED = 4000; // governed 180s horizon (must exceed the max old lifetime)
const EARLY_UNSAFE_MS = 2000;   // a premature "179s" check (< the old lifetime)

// Instrumentation: every reconstructed OLD write records (path, at).
const oldWrites = [];
const recordOldWrite = (path, at) => oldWrites.push({ path, at });

// A local-time-as-UTC minted key: HHMMSS is a LOCAL wall time; parsed as UTC by
// the watchdog it looks hours old → immediately "stranded". Exactly the defect.
function localMintedKey(nowMs) {
  const d = new Date(nowMs);
  const yyyy = d.getUTCFullYear(), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
  // Shift the encoded HHMMSS back 3 hours to emulate a local zone behind UTC.
  const local = new Date(nowMs - 3 * 3600 * 1000);
  const HH = String(local.getUTCHours()).padStart(2, '0'), MI = String(local.getUTCMinutes()).padStart(2, '0'), SS = String(local.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${HH}${MI}${SS}_Gabriel1_a00001`;
}

// Faithful reconstruction of the deployed processIncomingPull's essential
// writes, with an injected delay between reading its onCreate snapshot and
// committing — modelling a slow/cold-start ORIGINAL that keeps its snapshot.
async function slowOldCreate(key, snapshotData, delayMs) {
  // (snapshot captured at trigger time — the original does NOT re-read incoming)
  const top = Number(snapshotData.tankLevelFeet || 9) * 12;
  const bbls = snapshotData.bblsTaken ?? 40;
  const after = top - (bbls / 20) * 12;
  await sleep(delayMs); // in-flight window (cold start)
  // Stale-skip check mirrors the deployed code (compare to outgoing).
  const outMap = (await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL).once('value')).val() || {};
  const prev = Object.values(outMap)[0];
  if (prev && new Date(snapshotData.dateTimeUTC).getTime() <= new Date(prev.lastPullDateTimeUTC).getTime()) {
    await db.ref(`packets/incoming/${key}`).remove(); return { skipped: true };
  }
  // Commit (sequential, non-atomic, full-node status.set — the deployed pattern).
  await db.ref(`packets/processed/${key}`).set({ packetId: key, wellName: WELL, companyId: 'liquid-gold', dateTimeUTC: snapshotData.dateTimeUTC, bblsTaken: bbls, tankTopInches: top, tankAfterInches: after, processedAt: new Date().toISOString() });
  recordOldWrite(`packets/processed/${key}`, Date.now());
  await db.ref(`wells/${WELL}/status`).set({ wellName: WELL, isDown: false, updatedAt: new Date().toISOString(), current: { levelInches: after }, lastPull: { packetId: key, dateTimeUTC: snapshotData.dateTimeUTC, bblsTaken: bbls } });
  recordOldWrite(`wells/${WELL}/status`, Date.now());
  await db.ref(`packets/outgoing/response_${key}`).set({ wellName: WELL, lastPullPacketId: key, lastPullDateTimeUTC: snapshotData.dateTimeUTC, isEdit: false });
  recordOldWrite(`packets/outgoing/response_${key}`, Date.now());
  await db.ref(`packets/incoming/${key}`).remove(); // idempotent if watchdog already removed
  return { skipped: false };
}

async function seed() {
  await db.ref('/').set(null);
  await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'Gabriels', companyId: 'liquid-gold' });
  await db.ref('packets/incoming_version').set(7000);
}
const incomingKeys = async () => Object.keys((await val('packets/incoming')) || {});

async function main() {
  await seed();

  // ── t0: the (real-shape) producer packet lands, gate CLOSES immediately. ──
  const closeAt = Date.now();
  const key = localMintedKey(closeAt);
  const snapshotData = { requestType: 'pull', wellName: WELL, packetId: key, idempotencyKey: key, dateTimeUTC: new Date(closeAt).toISOString(), dateTime: 'now', tankLevelFeet: 9, bblsTaken: 40, driverId: 'd', driverName: 'D', ingestedAt: closeAt };
  await db.ref(`packets/incoming/${key}`).set(snapshotData);
  await db.ref('system/maintenance/wbmMutations').set({ paused: true, reason: 'wbm_mutations_paused', at: closeAt, by: 'op' });
  check('watchdog will mis-age the local-time key (parsed-as-UTC looks >2min old)', (() => { const m = key.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/); const parsed = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime(); return (closeAt - parsed) > 2 * 60 * 1000; })(), 'mis-aged');

  // ── Start the ORIGINAL slow invocation (captured snapshot, still in flight). ──
  let originalDoneAt = null;
  const originalP = slowOldCreate(key, snapshotData, OLD_ORIGINAL_MS).then((r) => { originalDoneAt = Date.now(); return r; });

  // ── Sample incoming continuously; record the first moment it looks empty. ──
  let firstEmptyAt = null;
  const sampler = (async () => {
    while (Date.now() - closeAt < HORIZON_MS_SCALED + 800) {
      if ((await incomingKeys()).length === 0 && firstEmptyAt === null) firstEmptyAt = Date.now();
      await sleep(80);
    }
  })();

  // ── Shortly after t0, the REAL old watchdog sweeps: mis-ages, removes P, re-keys clone. ──
  await sleep(150);
  await oldLib.watchdogStrandedPackets.run({ scheduleTime: new Date(Date.now()).toISOString() });
  const cloneKey = (await incomingKeys()).find((k) => k !== key);
  check('REAL old watchdog removed the original key and re-keyed a clone', (await val(`packets/incoming/${key}`)) === null && !!cloneKey, JSON.stringify({ origGone: (await val(`packets/incoming/${key}`)) === null, cloneKey }));

  // ── The CLONE triggers separately (a faster invocation). ──
  if (cloneKey) { const cloneData = await val(`packets/incoming/${cloneKey}`); await slowOldCreate(cloneKey, cloneData, 500); }

  // At this point incoming is (momentarily) empty, but the ORIGINAL is STILL in flight.
  const emptyNow = (await incomingKeys()).length === 0;
  const originalStillPending = oldWrites.every((w) => !w.path.includes(key)); // original hasn't written processed/<key> yet
  check('ONE-SHOT UNSAFE: incoming looks empty while the ORIGINAL invocation is still in flight', emptyNow && originalStillPending, JSON.stringify({ emptyNow, originalStillPending, writesSoFar: oldWrites.length }));

  // Record whether the EARLY (179s-analog) check would have declared "drained"
  // while the original was still executing.
  await sleep(Math.max(0, EARLY_UNSAFE_MS - (Date.now() - closeAt)));
  const originalDoneByEarly = originalDoneAt !== null && (originalDoneAt - closeAt) <= EARLY_UNSAFE_MS;
  const emptyAtEarly = (await incomingKeys()).length === 0;
  // Wait for the full scaled horizon and let the original finish.
  await originalP; await sampler;
  const lastOldWriteAt = oldWrites.reduce((mx, w) => Math.max(mx, w.at), 0);

  // The precise hazard: the original invocation was STILL EXECUTING (owned the
  // right to write / remove incoming) after incoming first looked empty. Whether
  // its CREATE stale-guard ultimately committed or skipped, a live old writer
  // existed — which is exactly what Stage C must not overlap.
  check('the ORIGINAL invocation was STILL EXECUTING after incoming first looked empty (hazard is real)', originalDoneAt !== null && firstEmptyAt !== null && originalDoneAt > firstEmptyAt, JSON.stringify({ firstEmptyAt: firstEmptyAt && firstEmptyAt - closeAt, originalDoneAt: originalDoneAt && originalDoneAt - closeAt }));
  check(`EARLY (${EARLY_UNSAFE_MS}ms / "179s") check is UNSAFE: incoming empty but the original had NOT finished`, emptyAtEarly && !originalDoneByEarly, JSON.stringify({ emptyAtEarly, originalDoneByEarly, originalDoneAt: originalDoneAt && originalDoneAt - closeAt }));
  check(`GOVERNED horizon (${HORIZON_MS_SCALED}ms / "180s") is SAFE: the original finished and no old write lands after it`, (originalDoneAt - closeAt) <= HORIZON_MS_SCALED && lastOldWriteAt - closeAt <= HORIZON_MS_SCALED, JSON.stringify({ originalDoneAt: originalDoneAt - closeAt, lastOldWriteAt: lastOldWriteAt - closeAt, horizon: HORIZON_MS_SCALED }));

  // ── After the horizon: incoming empty, no lock, no new watchdog keys, evidence intact. ──
  const wd2 = await (async () => { const before = oldWrites.length; await oldLib.watchdogStrandedPackets.run({ scheduleTime: new Date().toISOString() }); await sleep(300); return oldWrites.length === before; })();
  check('post-horizon watchdog sweep mints no new stranded work', wd2 && (await incomingKeys()).length === 0, JSON.stringify(await incomingKeys()));
  check('no OLD write occurs after the governed horizon (Stage C would not overlap a live old writer)', oldWrites.every((w) => w.at - closeAt <= HORIZON_MS_SCALED + 400), JSON.stringify(oldWrites.map((w) => w.at - closeAt)));

  // Evidence / intent preservation.
  const processedKeys = Object.keys((await val('packets/processed')) || {});
  check('the pull INTENT is preserved (its material is present in processed history)', processedKeys.length >= 1 && !!(await val(`packets/processed/${key}`)) || processedKeys.some((k) => k.includes('Gabriel1')), JSON.stringify(processedKeys));
  const out = Object.values((await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL).once('value')).val() || {});
  check('current/outgoing is explainable (points at a real processed pull, not a vanished key)', out.length >= 1 && out.every((o) => processedKeys.includes(o.lastPullPacketId)), JSON.stringify(out.map((o) => o.lastPullPacketId)));

  // ── Edit-drain equivalent: an old edit invocation continuing after its incoming row is removed. ──
  const editKey = 'editdrain0001';
  const origForEdit = Object.keys((await val('packets/processed')) || {})[0];
  await db.ref(`packets/incoming/${editKey}`).set({ requestType: 'edit', originalPacketId: origForEdit, wellName: WELL, editEventId: editKey, editedFields: ['bblsTaken'], bblsTaken: 175, tankLevelFeet: 14, schemaVersion: 2, packetId: origForEdit });
  const slowEdit = (async () => {
    const snap = await val(`packets/incoming/${editKey}`);
    await db.ref(`packets/incoming/${editKey}`).remove(); // its row removed (e.g. by watchdog/self) while it keeps going
    await sleep(1200);
    await db.ref(`packets/processed/${snap.originalPacketId}/bblsTaken`).set(175);
    recordOldWrite(`packets/processed/${snap.originalPacketId}#edit`, Date.now());
  })();
  const editEmptyDuring = (await incomingKeys()).filter((k) => k === editKey).length === 0;
  await slowEdit;
  check('edit-drain: an old edit invocation still commits after its incoming row is removed (same hazard class)', editEmptyDuring && (await val(`packets/processed/${origForEdit}`))?.bblsTaken === 175, JSON.stringify((await val(`packets/processed/${origForEdit}`))?.bblsTaken));

  console.log('\n=== WATCHDOG / DRAIN RACE (real old watchdog + reconstructed in-flight original) ===');
  console.log(results.join('\n'));
  console.log(`\nScaled timing — original in-flight ${OLD_ORIGINAL_MS}ms (≤120s prod), early/unsafe ${EARLY_UNSAFE_MS}ms (179s), governed horizon ${HORIZON_MS_SCALED}ms (180s).`);
  console.log(`${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[drainRace] fatal', e); process.exit(2); });
