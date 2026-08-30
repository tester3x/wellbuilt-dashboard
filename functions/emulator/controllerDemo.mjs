// controllerDemo.mjs — proves the rollout controller is OPERATIONAL, not a pure
// model (predeploy gate Rev-4 Blocker 1) and exercises fail-closed recovery +
// partial-Stage-C behavior (Blocker 5). It drives the REAL controller binary as
// a subprocess against the EMULATOR database (target=emulator), so real CAS
// writes happen — never production. Production stays untouched: the controller's
// production path additionally requires WB_ROLLOUT_PROD_AUTHORIZED=1, never set.
//
// RUN: node functions/emulator/run.mjs controller
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CTRL = join(ROOT, 'functions', 'tools', 'wbmRolloutController.mjs');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb` });
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();
const FLAG = 'system/maintenance/wbmMutations';

let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const flagVal = async () => (await db.ref(FLAG).once('value')).val();

function run(args, env = {}) {
  try {
    const out = execFileSync('node', [CTRL, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}
const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

async function main() {
  await db.ref(FLAG).set(null);
  const HEAD = git(['rev-parse', 'HEAD']);
  const RID = 'demo-' + HEAD.slice(0, 8);
  const jpath = join(ROOT, 'functions', 'tools', '.rollout-journal', `${RID}.json`);
  if (existsSync(jpath)) rmSync(jpath);

  // 1) plan — read-only, no writes.
  const plan = run(['plan', '--sha', HEAD]);
  check('plan runs and reports the staged sequence + read-only checks', /stage-a . close . drain/.test(plan.out) && /Stage A \(gated producers\)/.test(plan.out), String(plan.code));

  // 2) preflight — mints a confirmation token + journal (clean tree required).
  const pf = run(['preflight', '--rollout-id', RID, '--sha', HEAD]);
  const token = (pf.out.match(/Confirmation token.*?:\s*([0-9a-f]{24})/) || [])[1];
  check('preflight passes on the clean reviewed HEAD and mints a token', pf.code === 0 && !!token, pf.out.split('\n').slice(-3).join(' | '));

  // 3) close WITHOUT --execute → planned, no DB write.
  const closePlan = run(['close', '--rollout-id', RID, '--sha', HEAD, '--confirm', token, '--expect-state', 'OPEN']);
  check('close without --execute is DRY-RUN (flag stays absent)', (await flagVal()) === null && /PLANNED|dry-run/i.test(closePlan.out), JSON.stringify(await flagVal()));

  // 4) close WITH full auth (emulator target) → real CAS close.
  const auth = ['--execute', '--target', 'emulator', '--project', PROJECT_ID, '--sha', HEAD, '--confirm', token, '--rollout-id', RID];
  run(['close', ...auth, '--expect-state', 'OPEN']);
  check('close --execute performs the CAS: flag paused:true, governed metadata present', (await flagVal())?.paused === true && (await flagVal())?.rolloutId === RID && (await flagVal())?.state === 'CLOSED', JSON.stringify(await flagVal()));
  check('CAS changedAt is a server timestamp (number)', typeof (await flagVal())?.changedAt === 'number', JSON.stringify((await flagVal())?.changedAt));

  // 5) drain with a NON-empty incoming → horizon BREACH → fail-closed, stays CLOSED.
  await db.ref('packets/incoming/wbm_x').set({ requestType: 'pull', wellName: 'W', packetId: 'wbm_x' });
  const drainBreach = run(['drain', '--rollout-id', RID, '--horizon-seconds', '2']);
  check('drain BREACHES on non-empty incoming and refuses DRAINED_180', drainBreach.code !== 0 && /BREACH/i.test(drainBreach.out), drainBreach.out.split('\n').slice(-2).join(' | '));
  check('after a drain breach the gate is STILL closed (fail-closed)', (await flagVal())?.paused === true);

  // 6) drain clean → DRAINED_180.
  await db.ref('packets/incoming').set(null);
  const drainOk = run(['drain', '--rollout-id', RID, '--horizon-seconds', '2']);
  check('drain over a continuously-empty horizon → DRAINED_180', drainOk.code === 0 && /DRAINED_180/.test(drainOk.out), drainOk.out.split('\n').slice(-2).join(' | '));

  // 7) reopen BEFORE verify → refused (verify not passed).
  const reopenEarly = run(['reopen', ...auth, '--expect-state', 'VERIFYING']);
  check('reopen BEFORE a passing verify is refused; gate stays closed', reopenEarly.code !== 0 && (await flagVal())?.paused === true, reopenEarly.out.split('\n').slice(-1)[0]);

  // 8) verify WITHOUT the 4-revision proof → incomplete (reopen still blocked).
  const verifyNoProof = run(['verify', '--rollout-id', RID]);
  check('verify without the 4-consumer revision proof is INCOMPLETE', verifyNoProof.code !== 0 && /revisions proven: false/i.test(verifyNoProof.out), verifyNoProof.out.split('\n').slice(-2).join(' | '));

  // 8b) PARTIAL Stage-C: only 1 of 4 consumer revisions live → reconcile holds,
  //     verify INCOMPLETE (a CLI exit code is never trusted).
  const intended = JSON.stringify({ processIncomingPull: 'r1', processEditRequest: 'r1', processDeleteRequest: 'r1', watchdogStrandedPackets: 'r1' });
  const partial = JSON.stringify({ processIncomingPull: 'r1', processEditRequest: 'r0', processDeleteRequest: 'r0', watchdogStrandedPackets: 'r0' });
  const verifyPartial = run(['verify', '--rollout-id', RID, '--intended-revisions', intended, '--observed-revisions', partial]);
  check('PARTIAL Stage-C (1/4 revisions) → verify INCOMPLETE, reopen blocked', verifyPartial.code !== 0 && /revisions proven: false/i.test(verifyPartial.out), verifyPartial.out.split('\n').slice(-2).join(' | '));

  // 9) verify with all FOUR intended revisions live → passes (reconcile ok).
  const complete = JSON.stringify({ processIncomingPull: 'r1', processEditRequest: 'r1', processDeleteRequest: 'r1', watchdogStrandedPackets: 'r1' });
  const verifyOk = run(['verify', '--rollout-id', RID, '--intended-revisions', intended, '--observed-revisions', complete]);
  check('verify PASSES with all 4 consumer revisions matching + empty incoming + no lock', verifyOk.code === 0 && /verify PASSED/.test(verifyOk.out), verifyOk.out.split('\n').slice(-2).join(' | '));

  // 10) reopen WITH full auth → CAS reopen (paused:false).
  const reopen = run(['reopen', ...auth, '--expect-state', 'VERIFYING']);
  check('reopen --execute after verify performs the CAS reopen (paused:false)', (await flagVal())?.paused === false && (await flagVal())?.state === 'OPEN', JSON.stringify(await flagVal()));

  // 11) FAIL-CLOSED: a close whose CAS is refused (flag already closed by another
  //     rollout) forces HELD_CLOSED and leaves admission closed.
  const RID2 = RID + '-b';
  const jpath2 = join(ROOT, 'functions', 'tools', '.rollout-journal', `${RID2}.json`);
  if (existsSync(jpath2)) rmSync(jpath2);
  run(['preflight', '--rollout-id', RID2, '--sha', HEAD]);
  const token2 = (run(['preflight', '--rollout-id', RID2, '--sha', HEAD]).out.match(/Confirmation token.*?:\s*([0-9a-f]{24})/) || [])[1];
  await db.ref(FLAG).set({ paused: true, state: 'CLOSED', rolloutId: 'someone-else', reviewedSha: HEAD, changedAt: 1, changedBy: 'x', reason: 'y' });
  const auth2 = ['--execute', '--target', 'emulator', '--project', PROJECT_ID, '--sha', HEAD, '--confirm', token2, '--rollout-id', RID2];
  const closeHeld = run(['close', ...auth2, '--expect-state', 'OPEN']);
  const j2 = JSON.parse(readFileSync(jpath2, 'utf8'));
  check('a refused CAS close forces HELD_CLOSED', closeHeld.code !== 0 && j2.state === 'HELD_CLOSED' && /HELD_CLOSED/.test(closeHeld.out), closeHeld.out.split('\n').slice(-6).join(' | '));
  check('HELD_CLOSED leaves admission CLOSED (never auto-reopened)', (await flagVal())?.paused === true);
  check('HELD_CLOSED prints exact recovery instructions', /Recovery:/.test(closeHeld.out) && /Never reopen on a CLI exit code/.test(closeHeld.out));

  // 12) resume from HELD_CLOSED → stays closed, refuses to move forward.
  const resume = run(['resume', '--rollout-id', RID2]);
  check('resume from HELD_CLOSED keeps the gate closed and refuses reopen', /HELD_CLOSED/.test(resume.out) && /will not reopen/i.test(resume.out) && (await flagVal())?.paused === true, resume.out.split('\n').slice(-3).join(' | '));

  // 13) reopen from HELD_CLOSED → refused.
  const reopenHeld = run(['reopen', ...auth2, '--expect-state', 'VERIFYING']);
  check('reopen while HELD_CLOSED is refused', reopenHeld.code !== 0 && (await flagVal())?.paused === true, reopenHeld.out.split('\n').slice(-1)[0]);

  console.log('\n=== ROLLOUT CONTROLLER (operational, against the emulator) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[controllerDemo] fatal', e); process.exit(2); });
