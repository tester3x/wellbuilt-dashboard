// controllerDemo.mjs — execution-boundary proof for the rollout controller
// (predeploy gate Rev-4 FINAL). Drives the REAL controller binary against the
// EMULATOR db, with a FAKE firebase (records argv, configurable exit, updates a
// mock live-revisions file) and a file-backed mock revision provider — so the
// controller OWNS both deploys (internal spawn, shell:false, exact per-stage
// argv) and reads LIVE revisions itself; a CLI exit code never governs. No
// production is touched (WB_DEPLOY_BIN/mock gate the spawn; prod path also needs
// WB_ROLLOUT_PROD_AUTHORIZED, never set).
//
// RUN: node functions/emulator/run.mjs controller
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CTRL = join(ROOT, 'functions', 'tools', 'wbmRolloutController.mjs');
const FAKE = join(ROOT, 'functions', 'emulator', 'fake-firebase.js');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb` });
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();
const FLAG = 'system/maintenance/wbmMutations';

const SCRATCH = join(process.env.TEMP || process.env.TMP || HERE, 'wbm-exec-boundary');
mkdirSync(SCRATCH, { recursive: true });
const MOCK = join(SCRATCH, 'revisions.json');
const ARGV = join(SCRATCH, 'argv.log');

let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const flagVal = async () => (await db.ref(FLAG).once('value')).val();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const HEAD = git(['rev-parse', 'HEAD']);

const PRODUCERS = ['ingestWbmPull', 'ingestWbmEdit', 'adminSubmitPullEdit'];
const CONSUMERS = ['processIncomingPull', 'processEditRequest', 'processDeleteRequest', 'watchdogStrandedPackets'];
const setRevs = (o) => writeFileSync(MOCK, JSON.stringify(o));
const jpath = (rid) => join(ROOT, 'functions', 'tools', '.rollout-journal', `${rid}.json`);
const getJournal = (rid) => JSON.parse(readFileSync(jpath(rid), 'utf8'));
const setJournal = (rid, patch) => writeFileSync(jpath(rid), JSON.stringify({ ...getJournal(rid), ...patch }, null, 2));
const lastArgv = () => { const lines = existsSync(ARGV) ? readFileSync(ARGV, 'utf8').trim().split('\n').filter(Boolean) : []; return lines.length ? JSON.parse(lines[lines.length - 1]) : null; };
const clearArgv = () => { if (existsSync(ARGV)) rmSync(ARGV); };

function run(args, env = {}) {
  try { return { code: 0, out: execFileSync('node', [CTRL, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}
function preflight(rid) {
  if (existsSync(jpath(rid))) rmSync(jpath(rid));
  const out = run(['preflight', '--rollout-id', rid, '--sha', HEAD]).out;
  return (out.match(/Confirmation token.*?:\s*([0-9a-f]{24})/) || [])[1];
}
const baseEnv = { WB_DEPLOY_BIN: 'node', WB_DEPLOY_PREFIX: JSON.stringify([FAKE]), WB_MOCK_REVISIONS_FILE: MOCK, WB_FAKE_ARGV_FILE: ARGV };
const auth = (rid, token) => ['--execute', '--target', 'emulator', '--project', PROJECT_ID, '--sha', HEAD, '--confirm', token, '--rollout-id', rid];

async function main() {
  await db.ref(FLAG).set(null);
  await db.ref('packets/incoming').set(null);

  // ══ HAPPY PATH — controller owns both deploys + reads live revisions ══
  const RID = 'exec-happy';
  const t = preflight(RID);
  check('preflight mints a token bound to the reviewed SHA', !!t);
  setRevs({ ingestWbmPull: 'p0', ingestWbmEdit: 'p0', adminSubmitPullEdit: 'p0', processIncomingPull: 'c0', processEditRequest: 'c0', processDeleteRequest: 'c0', watchdogStrandedPackets: 'c0' });

  // Stage A: fake deploy advances producers p0→p1, exit 0.
  clearArgv();
  const sa = run(['stage-a', ...auth(RID, t), '--expect-state', 'OPEN'], { ...baseEnv, WB_STAGE_A_STABILIZE_SECONDS: '0', WB_FAKE_EXIT: '0', WB_FAKE_SET_REVISIONS: JSON.stringify({ ingestWbmPull: 'p1', ingestWbmEdit: 'p1', adminSubmitPullEdit: 'p1' }) });
  check('Stage-A: controller spawned the deploy + all 3 producer revisions advanced+stable (live)', sa.code === 0 && /producer revisions ADVANCED/.test(sa.out), sa.out.split('\n').slice(-2).join(' | '));
  check('Stage-A argv is EXACTLY the producer stage (shell:false, no free-form)', JSON.stringify(lastArgv()) === JSON.stringify(['deploy', '--project', 'wellbuilt-sync', '--only', 'functions:ingestWbmPull,functions:ingestWbmEdit,functions:adminSubmitPullEdit']), JSON.stringify(lastArgv()));
  check('Stage-A journal records argv + exit + a sanitized output digest (no raw output)', (() => { const h = getJournal(RID).history.find((x) => x.event === 'stage_a_deploy'); return h && Array.isArray(h.argv) && typeof h.exitCode === 'number' && /^[0-9a-f]{16}$/.test(h.outputDigest || ''); })());

  // CLOSE: independent LIVE recheck (producers still p1).
  const cl = run(['close', ...auth(RID, t), '--expect-state', 'OPEN'], baseEnv);
  check('CLOSE: live repeat producer-revision check passes → CAS close', (await flagVal())?.paused === true && (await flagVal())?.state === 'CLOSED', JSON.stringify(await flagVal()));

  // DRAIN clean → DRAINED_180.
  await db.ref('packets/incoming').set(null);
  const dr = run(['drain', '--rollout-id', RID, '--horizon-seconds', '2'], baseEnv);
  check('DRAIN clean → DRAINED_180', dr.code === 0 && /DRAINED_180/.test(dr.out));

  // Stage C: fake deploy advances consumers c0→c1, exit 0.
  clearArgv();
  const sc = run(['stage-c', ...auth(RID, t), '--expect-state', 'DRAINED_180'], { ...baseEnv, WB_FAKE_EXIT: '0', WB_FAKE_SET_REVISIONS: JSON.stringify({ processIncomingPull: 'c1', processEditRequest: 'c1', processDeleteRequest: 'c1', watchdogStrandedPackets: 'c1' }) });
  check('Stage-C: controller spawned the deploy + all 4 consumer revisions advanced+stable (live)', sc.code === 0 && /consumer revisions ADVANCED/.test(sc.out), sc.out.split('\n').slice(-2).join(' | '));
  check('Stage-C argv is EXACTLY the consumer stage (shell:false, no free-form)', JSON.stringify(lastArgv()) === JSON.stringify(['deploy', '--project', 'wellbuilt-sync', '--only', 'functions:processIncomingPull,functions:processEditRequest,functions:processDeleteRequest,functions:watchdogStrandedPackets']), JSON.stringify(lastArgv()));

  // VERIFY (live 4/4) then REOPEN (live guard + clean drain).
  const vf = run(['verify', '--rollout-id', RID], baseEnv);
  check('VERIFY: live 4/4 consumer revisions == stage-c + empty + no lock → passed', vf.code === 0 && /verify PASSED/.test(vf.out), vf.out.split('\n').slice(-1)[0]);
  const ro = run(['reopen', ...auth(RID, t), '--expect-state', 'VERIFYING'], baseEnv);
  check('REOPEN: only after live 4/4 + clean drain → CAS reopen (paused:false)', (await flagVal())?.paused === false && (await flagVal())?.state === 'OPEN', JSON.stringify(await flagVal()));

  // ══ CLOSE re-reads LIVE (not the journal): a rolled producer refuses ══
  const RID2 = 'exec-liveclose';
  const t2 = preflight(RID2);
  await db.ref(FLAG).set(null);
  setRevs({ ingestWbmPull: 'p1', ingestWbmEdit: 'p1', adminSubmitPullEdit: 'p1', processIncomingPull: 'c1', processEditRequest: 'c1', processDeleteRequest: 'c1', watchdogStrandedPackets: 'c1' });
  run(['stage-a', ...auth(RID2, t2), '--expect-state', 'OPEN'], { ...baseEnv, WB_STAGE_A_STABILIZE_SECONDS: '0', WB_FAKE_EXIT: '0', WB_FAKE_SET_REVISIONS: JSON.stringify({ ingestWbmPull: 'p2', ingestWbmEdit: 'p2', adminSubmitPullEdit: 'p2' }) });
  // Now a producer "rolls" live to p3 after stabilization.
  setRevs({ ingestWbmPull: 'p2', ingestWbmEdit: 'p3', adminSubmitPullEdit: 'p2', processIncomingPull: 'c1', processEditRequest: 'c1', processDeleteRequest: 'c1', watchdogStrandedPackets: 'c1' });
  const clRoll = run(['close', ...auth(RID2, t2), '--expect-state', 'OPEN'], baseEnv);
  check('CLOSE reads LIVE and refuses when a producer revision drifted post-stabilization', clRoll.code !== 0 && /live repeat revision check does NOT match/i.test(clRoll.out) && (await flagVal()) === null, clRoll.out.split('\n').slice(-1)[0]);

  // ══ Stage-C boundary cases (each an independent HELD-able rollout) ══
  async function stageCcase(rid, fakeExit, setRevisions) {
    const tk = preflight(rid);
    setRevs({ processIncomingPull: 'c0', processEditRequest: 'c0', processDeleteRequest: 'c0', watchdogStrandedPackets: 'c0' });
    setJournal(rid, { state: 'DRAINED_180', stageA: { producers: { ingestWbmPull: 'p1', ingestWbmEdit: 'p1', adminSubmitPullEdit: 'p1' }, settleDeadlineMs: 1, settleSeconds: 0, verifiedAtMs: 1 } });
    clearArgv();
    const env = { ...baseEnv, WB_FAKE_EXIT: String(fakeExit) };
    if (setRevisions) env.WB_FAKE_SET_REVISIONS = JSON.stringify(setRevisions);
    const r = run(['stage-c', ...auth(rid, tk), '--expect-state', 'DRAINED_180'], env);
    return { r, tk };
  }
  // nonzero exit + revisions unchanged → HELD.
  const nz = await stageCcase('exec-nz', 1, null);
  check('Stage-C nonzero exit + unchanged live → HELD_CLOSED', nz.r.code !== 0 && getJournal('exec-nz').state === 'HELD_CLOSED' && /INCOMPLETE from LIVE/.test(nz.r.out), nz.r.out.split('\n').slice(-3).join(' | '));
  // exit 0 + incomplete revisions → HELD (exit code NOT trusted).
  const ez = await stageCcase('exec-ez', 0, { processIncomingPull: 'c1' });
  check('Stage-C exit 0 + INCOMPLETE live revisions → HELD_CLOSED (exit code not trusted)', ez.r.code !== 0 && getJournal('exec-ez').state === 'HELD_CLOSED', ez.r.out.split('\n').slice(-2).join(' | '));
  // exit nonzero + all revisions live → reconciles from live truth (success).
  const nzlive = await stageCcase('exec-nzlive', 1, { processIncomingPull: 'c1', processEditRequest: 'c1', processDeleteRequest: 'c1', watchdogStrandedPackets: 'c1' });
  check('Stage-C nonzero exit BUT all 4 live+stable → reconciles from LIVE truth (success)', nzlive.r.code === 0 && getJournal('exec-nzlive').state === 'CONSUMERS_DEPLOYED' && /consumer revisions ADVANCED/.test(nzlive.r.out), nzlive.r.out.split('\n').slice(-2).join(' | '));

  // ══ Partial Stage-C never reopens; resume re-reads live ══
  const reopenPartial = run(['reopen', ...auth('exec-ez', ez.tk), '--expect-state', 'VERIFYING'], baseEnv);
  check('partial Stage-C: reopen refused (HELD_CLOSED)', reopenPartial.code !== 0);
  const resumePartial = run(['resume', '--rollout-id', 'exec-ez'], baseEnv);
  check('resume independently RE-READS live consumer revisions and stays HELD_CLOSED', /live consumer revisions:\s+processIncomingPull=/.test(resumePartial.out) && /HELD_CLOSED/.test(resumePartial.out), resumePartial.out.split('\n').slice(-4).join(' | '));

  // ══ Forged operator revisions refused in PRODUCTION mode ══
  const forge = run(['verify', '--rollout-id', RID, '--target', 'production', '--observed-revisions', '{"processIncomingPull":"c1"}'], baseEnv);
  check('production mode: operator-supplied --observed-revisions is REFUSED (controller reads live)', forge.code !== 0 && /not accepted in production/i.test(forge.out), forge.out.split('\n').slice(-1)[0]);

  // ══ reopen only after live 4/4 AND clean drain: a dirtied drain refuses ══
  await db.ref(FLAG).set({ paused: true, state: 'CLOSED', rolloutId: RID, reviewedSha: HEAD, changedAt: 1, changedBy: 'x', reason: 'y' });
  setJournal(RID, { state: 'VERIFYING', verifyPassed: true, stageC: { consumers: { processIncomingPull: 'c1', processEditRequest: 'c1', processDeleteRequest: 'c1', watchdogStrandedPackets: 'c1' } } });
  setRevs({ processIncomingPull: 'c1', processEditRequest: 'c1', processDeleteRequest: 'c1', watchdogStrandedPackets: 'c1' });
  await db.ref('packets/incoming/dirty1').set({ requestType: 'pull', wellName: 'W', packetId: 'dirty1' }); // drain no longer clean
  const roDirty = run(['reopen', ...auth(RID, t), '--expect-state', 'VERIFYING'], baseEnv);
  check('REOPEN refused when the drain is no longer clean at reopen (incoming non-empty)', roDirty.code !== 0 && /drain no longer clean|incoming not empty/i.test(roDirty.out) && (await flagVal())?.paused === true, roDirty.out.split('\n').slice(-3).join(' | '));
  await db.ref('packets/incoming').set(null);

  // ══ HELD_CLOSED recovery invariants (retained from the fail-closed proof) ══
  const heldJ = getJournal('exec-nz');
  check('HELD_CLOSED leaves admission decision to a human (recovery instructions printed)', /Recovery:/.test(nz.r.out) && /Never reopen on a CLI exit code/.test(nz.r.out) && heldJ.state === 'HELD_CLOSED');

  console.log('\n=== ROLLOUT CONTROLLER — execution boundary (owns deploys, reads live revisions) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[controllerDemo] fatal', e); process.exit(2); });
