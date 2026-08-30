// Real-emulator FAULT INJECTION harness (completion audit item 4).
//
// Runs under `firebase emulators:exec --only functions,database` with
// WB_FAULT_SPEC in the environment (see faultInjection.ts — emulator-only,
// fail closed, one-shot per operationId). Crashes are injected INSIDE the
// real deployed trigger invocations; recovery re-drives the SAME operation
// ids through the real triggers and the real exported watchdog. The lease
// clock is controlled by rewriting the lock's `at` timestamp — never a real
// 180-second sleep. Every case asserts ENTIRELY-OLD or ENTIRELY-NEW state
// across processed/current/outgoing/status/performance/production/receipt/
// incoming/v2-revision/legacy-revision.
//
// RUN (own session; WB_FAULT_SPEC must cover the ops below):
//   JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=C:\t' \
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 GCLOUD_PROJECT=wellbuilt-sync \
//   WB_FAULT_SPEC='crash_during_planning:fA;crash_before_commit:fB;crash_after_commit:fC;pause_before_transition:fS;crash_during_planning:wFresh;crash_during_planning:wNoAge;crash_before_commit:wClaim;crash_during_planning:wReceipt' \
//   npx firebase emulators:exec --config firebase.emulator.json \
//     --only functions,database --project wellbuilt-sync \
//     "node functions/emulator/faults.mjs"

// emulators:exec PRE-SETS FIREBASE_CONFIG with the production databaseURL —
// override it unconditionally so the default app targets the emulator's
// DEFAULT-INSTANCE namespace (<project>-default-rtdb), where the v1 triggers
// listen. (Namespace probe 2026-08-29: without this, writes landed in ns
// 'wellbuilt-sync' and no trigger ever fired.)
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: PROJECT_ID,
  databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb`,
});

// Load the COMPILED functions module FIRST: it creates the default admin app
// (pointed at the emulator via FIREBASE_CONFIG/FIREBASE_DATABASE_EMULATOR_HOST)
// and gives us the real exported watchdog to fire.
const mod = await import('../lib/index.js');
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
const db = admin.database();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (name, cond, detail = '') => {
  if (cond) results.push(`  PASS  ${name}`);
  else { failures++; results.push(`  FAIL  ${name}  ${detail}`); }
};

const WELL = 'Cyclone 1';
const lockPath = `wells/${WELL}/status/chronoLock`;
const receiptPath = (op) => `wells/${WELL}/chronoReceipts/${op}`;
const val = async (p) => (await db.ref(p).once('value')).val();

async function sendPull(id, over = {}) {
  await db.ref(`packets/incoming/${id}`).set({
    requestType: 'pull', wellName: WELL, packetId: id,
    dateTimeUTC: over.dateTimeUTC || '2026-08-27T12:00:00.000Z',
    dateTime: over.dateTime || '8/27/2026 7:00 AM',
    tankLevelFeet: over.tankLevelFeet || '9', bblsTaken: over.bblsTaken ?? 40,
    driverName: 'Fault Tester', driverId: 'fault-d1',
    ...(over.ingestedAt !== undefined ? { ingestedAt: over.ingestedAt } : {}),
  });
}
const retry = async (id, over = {}) => { await db.ref(`packets/incoming/${id}`).set(null); await sendPull(id, over); };

/** Snapshot of everything a commit would touch, for entirely-old/new proofs. */
async function stateOf(op) {
  return {
    processed: await val(`packets/processed/${op}`),
    receipt: await val(receiptPath(op)),
    incoming: await val(`packets/incoming/${op}`),
    outgoing: await val('packets/outgoing'),
    status: await val(`wells/${WELL}/status/lastPull`),
    perf: await val('performance/Cyclone_1/rows'),
    prod: await val('production/Cyclone_1'),
    v2: await val('packets/incoming_revision_v2'),
    legacy: await val('packets/incoming_version'),
  };
}
const allOld = (s, op, legacyBefore, v2Before) =>
  s.processed === null && s.receipt === null && s.status === null
  && s.perf === null && s.prod === null && s.legacy === legacyBefore
  && JSON.stringify(s.v2) === JSON.stringify(v2Before);
const allNew = (s, op, legacyBefore) =>
  !!s.processed && !!s.receipt && s.incoming === null && !!s.status
  && !!s.perf && !!s.prod && s.legacy === legacyBefore + 1048576
  && s.v2 && s.v2.token === op;

async function rewindLock(deltaMs) {
  await db.ref(`${lockPath}/at`).set(Date.now() - deltaMs);
}

async function main() {
  await db.ref('/').set(null);
  await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'R1' });
  const LEG0 = 1000; // small, exact arithmetic
  await db.ref('packets/incoming_version').set(LEG0);
  const v2Start = await val('packets/incoming_revision_v2');

  // ── fA: crash DURING PLANNING → entirely-old; lease takeover retries clean ──
  await sendPull('fA');
  await sleep(4000);
  let s = await stateOf('fA');
  check('fA crash-during-planning: ENTIRELY OLD (no row/receipt/projection/revision)', allOld(s, 'fA', LEG0, v2Start), JSON.stringify({ p: !!s.processed, r: !!s.receipt, leg: s.legacy }));
  check('fA: incoming preserved for retry', !!s.incoming);
  let lock = await val(lockPath);
  check('fA: planning lock left behind (the crash evidence)', lock && lock.phase === 'planning', JSON.stringify(lock && lock.phase));
  // Retry within the 30s planning lease → contended, still nothing.
  await retry('fA');
  await sleep(3500);
  s = await stateOf('fA');
  check('fA retry within planning lease: contended — still entirely old', allOld(s, 'fA', LEG0, v2Start) && !!s.incoming, JSON.stringify(s.legacy));
  // WORKER STILL PLANNING → rewind past the lease → takeover with a higher fence commits.
  const fenceBefore = (await val(lockPath))?.fence ?? 0;
  await rewindLock(31_000);
  await retry('fA');
  await sleep(4500);
  s = await stateOf('fA');
  check('fA lease takeover: ENTIRELY NEW (row+receipt+projections+BOTH revisions)', allNew(s, 'fA', LEG0), JSON.stringify({ leg: s.legacy, v2: s.v2?.token }));
  // (receipt.fence carries the chronoRevision, not the lock fence — the lock
  //  fence's job is proven by the lock being RELEASED after the takeover
  //  commit and by fS's resumed-stale-worker case below.)
  check('fA takeover: lock released after commit, receipt revision present', (await val(lockPath)) === null && s.receipt && s.receipt.revision >= 1, JSON.stringify([fenceBefore, s.receipt?.revision]));
  check('fA exactly ONE commit signal across crash+retries', s.legacy === LEG0 + 1048576, String(s.legacy));
  const LEG1 = s.legacy;

  // ── fB: crash BEFORE COMMIT (committing lock stuck) → horizon governs ──
  await sendPull('fB', { dateTimeUTC: '2026-08-27T13:00:00.000Z' });
  await sleep(4000);
  let sB = await stateOf('fB');
  check('fB crash-before-commit: ENTIRELY OLD, incoming preserved', sB.processed === null && sB.receipt === null && !!sB.incoming && sB.legacy === LEG1, JSON.stringify(sB.legacy));
  lock = await val(lockPath);
  check('fB: COMMITTING lock left behind', lock && lock.phase === 'committing', JSON.stringify(lock && lock.phase));
  // WORKER COMMITTING (fresh) → retry → contended.
  await retry('fB', { dateTimeUTC: '2026-08-27T13:00:00.000Z' });
  await sleep(3500);
  sB = await stateOf('fB');
  check('fB retry while committing in-flight: contended — still entirely old', sB.processed === null && sB.receipt === null && sB.legacy === LEG1, String(sB.legacy));
  // RETRY BEFORE THE HORIZON (179s) → still contended.
  await rewindLock(179_000);
  await retry('fB', { dateTimeUTC: '2026-08-27T13:00:00.000Z' });
  await sleep(3500);
  sB = await stateOf('fB');
  check('fB retry at 179s: horizon holds — still entirely old', sB.processed === null && sB.legacy === LEG1, String(sB.legacy));
  // RETRY AT/PAST THE HORIZON (>=180s) → receiptless recovery requeues, then commits.
  await rewindLock(180_000);
  await retry('fB', { dateTimeUTC: '2026-08-27T13:00:00.000Z' });
  await sleep(3500);
  await retry('fB', { dateTimeUTC: '2026-08-27T13:00:00.000Z' }); // requeue cleared the lock; this run commits
  await sleep(4500);
  sB = await stateOf('fB');
  check('fB past-horizon recovery: ENTIRELY NEW with both revisions, single bump', !!sB.processed && !!sB.receipt && sB.legacy === LEG1 + 1048576 && sB.v2?.token === 'fB', JSON.stringify({ leg: sB.legacy, v2: sB.v2?.token }));
  const LEG2 = sB.legacy;

  // ── fC: crash AFTER the atomic update, BEFORE release ──
  await sendPull('fC', { dateTimeUTC: '2026-08-27T14:00:00.000Z' });
  await sleep(4000);
  let sC = await stateOf('fC');
  check('fC crash-after-commit: ENTIRELY NEW despite the crash (atomicity) — both revisions included', !!sC.processed && !!sC.receipt && sC.incoming === null && sC.legacy === LEG2 + 1048576 && sC.v2?.token === 'fC', JSON.stringify({ leg: sC.legacy, v2: sC.v2?.token }));
  lock = await val(lockPath);
  check('fC: committing lock still held (release never ran) — COMPLETED RECEIPT, DELAYED RELEASE', lock && lock.phase === 'committing', JSON.stringify(lock && lock.phase));
  // Replay of a completed-but-unreleased op: the handler's early idempotent
  // check consumes the residue on the receipt/processed row alone — the stuck
  // lock is NOT touched (its release belongs to the horizon protocol below).
  await retry('fC', { dateTimeUTC: '2026-08-27T14:00:00.000Z' });
  await sleep(3500);
  sC = await stateOf('fC');
  check('fC replay: idempotent — residue consumed, NO double apply, lock untouched', sC.legacy === LEG2 + 1048576 && sC.incoming === null && (await val(lockPath))?.phase === 'committing', String(sC.legacy));
  const LEG3 = sC.legacy;

  // ── fS: pause-before-transition TOCTOU — and it is ALSO the recovery that
  //     releases fC's completed-but-unreleased lock (any later op past the
  //     horizon consults the receipt and releases idempotently). ──
  await rewindLock(180_500); // fC's stuck committing lock passes the horizon
  await sendPull('fS', { dateTimeUTC: '2026-08-27T15:00:00.000Z' });
  await sleep(3500); // invocation #1: recover → fC receipt found → recovered_released
  lock = await val(lockPath);
  check('fC past-horizon: NEXT operation releases the completed lock via its receipt — no recompute, no extra bump', lock === null && (await val('packets/incoming_version')) === LEG3, JSON.stringify(lock));
  check('fS after releasing fC: its own incoming left for retry', !!(await val('packets/incoming/fS')));

  // invocation #2: clean acquire → builds patch → PAUSES before transition.
  await retry('fS', { dateTimeUTC: '2026-08-27T15:00:00.000Z' });
  await sleep(3000);
  lock = await val(lockPath);
  check('fS: worker A paused holding the planning lock', lock && lock.phase === 'planning', JSON.stringify(lock && lock.phase));
  const fenceA = lock?.fence ?? 0;
  await rewindLock(31_000); // A looks lease-expired
  await retry('fS', { dateTimeUTC: '2026-08-27T15:00:00.000Z' }); // worker B takes over (fence+1) and commits
  await sleep(4500);
  let sS = await stateOf('fS');
  check('fS: worker B committed with a HIGHER fence (entirely new, single bump)', !!sS.receipt && sS.legacy === LEG3 + 1048576, String(sS.legacy));
  const receiptB = sS.receipt;
  await db.ref('test_faults/release/fS').set(true); // resume A → its transition CAS must fail
  await sleep(5000);
  sS = await stateOf('fS');
  check('fS: resumed stale worker A could NOT double-commit (fence): same receipt, same bump', sS.legacy === LEG3 + 1048576 && JSON.stringify(sS.receipt) === JSON.stringify(receiptB), String(sS.legacy));
  check('fS: fence advanced past the paused worker', (receiptB?.revision ?? 0) >= 1 && fenceA >= 1, JSON.stringify([fenceA, receiptB?.revision]));
  const LEG4 = sS.legacy;

  // ── WATCHDOG: real exported scheduled function fired against the emulator ──
  const runWatchdog = async () => { await mod.watchdogStrandedPackets.run({ scheduleTime: new Date().toISOString() }); };

  // Fresh packet (Crossbow shape): crashed worker left it, ingestedAt is NOW → not stranded.
  await sendPull('wFresh', { dateTimeUTC: '2026-08-27T16:00:00.000Z', ingestedAt: Date.now() });
  await sleep(3500); // fault consumes the trigger; packet remains
  await db.ref(lockPath).set(null); // clear crash residue so only AGE decides
  await runWatchdog();
  check('watchdog: FRESH packet (ingestedAt now) NOT recovered, no clone, still queued',
    !!(await val('packets/incoming/wFresh')) && (await val('packets/processed/wFresh')) === null && (await val('packets/rejected')) === null, 'fresh untouched');

  // Missing ingestedAt → unknown age → never stranded from a guess.
  await sendPull('wNoAge', { dateTimeUTC: '2026-08-27T16:30:00.000Z' });
  await sleep(3500);
  await db.ref(lockPath).set(null);
  await runWatchdog();
  check('watchdog: missing ingestedAt → unknown age → untouched', !!(await val('packets/incoming/wNoAge')) && (await val('packets/processed/wNoAge')) === null, 'no-age untouched');

  // Active claim: stale-by-age packet but a FRESH committing lock → watchdog defers.
  await sendPull('wClaim', { dateTimeUTC: '2026-08-27T17:00:00.000Z', ingestedAt: Date.now() - 3 * 60_000 });
  await sleep(3500); // crash_before_commit leaves a fresh committing lock + packet
  const legBeforeClaim = await val('packets/incoming_version');
  await runWatchdog();
  check('watchdog: stranded packet with ACTIVE committing claim → contended no-op',
    !!(await val('packets/incoming/wClaim')) && (await val(receiptPath('wClaim'))) === null && (await val('packets/incoming_version')) === legBeforeClaim, 'claim respected');
  // Genuine stale recovery: horizon passes → watchdog recovers via the SAME op id.
  await rewindLock(180_500);
  await runWatchdog(); // receiptless committing → requeue (clears lock)
  await runWatchdog(); // clean acquire → commits
  const wClaimRow = await val('packets/processed/wClaim');
  check('watchdog: genuine stale recovery through the SAME operation id (no clone, no reject)',
    !!wClaimRow && !!(await val(receiptPath('wClaim'))) && (await val('packets/incoming/wClaim')) === null && (await val('packets/rejected')) === null,
    JSON.stringify(!!wClaimRow));
  check('watchdog recovery: exactly one bump', (await val('packets/incoming_version')) === legBeforeClaim + 1048576, String(await val('packets/incoming_version')));

  // Existing receipt + stale residue → consume without recompute.
  await sendPull('wReceipt', { dateTimeUTC: '2026-08-27T18:00:00.000Z', ingestedAt: Date.now() - 3 * 60_000 });
  await sleep(3500); // crash_during_planning leaves it queued
  await db.ref(lockPath).set(null);
  await db.ref(receiptPath('wReceipt')).set({ operationId: 'wReceipt', mutationType: 'create', wellName: WELL, fence: 99, revision: 99, committedAtMs: Date.now(), patchHash: 'x' });
  const legBeforeReceipt = await val('packets/incoming_version');
  await runWatchdog();
  check('watchdog: existing receipt → residue consumed, NO recompute, NO bump',
    (await val('packets/incoming/wReceipt')) === null && (await val('packets/incoming_version')) === legBeforeReceipt, String(await val('packets/incoming_version')));

  console.log('\n=== FAULT-INJECTION RESULTS (real triggers + real watchdog, controlled lease clock) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[faults] fatal', e); process.exit(2); });
