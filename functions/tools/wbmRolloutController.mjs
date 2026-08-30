#!/usr/bin/env node
// wbmRolloutController.mjs — the ONE executable, fail-closed controller for the
// governed WB-M staged rollout (predeploy gate Rev-4 Blocker 1). It integrates
// every safety check into a single enforced procedure with a durable journal
// and interruption recovery. It is DRY-RUN by default and performs NO
// production mutation or deploy unless the operator supplies the full execution
// authorization set — which is intentionally NOT supplied in this engagement.
//
// Modes:  plan preflight stage-a close drain stage-c verify reopen status resume
//
// Execution of any state-changing mode (stage-a, close, stage-c, reopen)
// requires ALL of:
//   --execute
//   --project wellbuilt-sync           (exact reviewed project)
//   --sha <reviewed HEAD>              (exact; must equal git HEAD and journal)
//   --expect-state <state>            (exact expected current state)
//   --confirm <token>                 (operator token minted by `preflight`)
//   appropriate credentials for the operation (never printed)
// and, for --target production, the env WB_ROLLOUT_PROD_AUTHORIZED=1 (a
// deliberate belt-and-suspenders that is never set here). Default target is
// 'emulator' so a stray run cannot touch production.
//
// The controller NEVER auto-reopens on error. On any exception after admission
// closes it records the failure, forces HELD_CLOSED, leaves admission closed,
// prints exact recovery steps, and refuses Stage C / reopen until reconciled.
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PROJECT = 'wellbuilt-sync';
const BRANCH = 'integration/wbm-backdated-chrono-reconcile';
const DEPLOYED_RULES_SHA256 = '5ba10f055a0673e151302b5f9b80ef6e38f006448acc8c7cd5bb47344899b314';
const STAGE_A = ['ingestWbmPull', 'ingestWbmEdit', 'adminSubmitPullEdit'];
const STAGE_C = ['processIncomingPull', 'processEditRequest', 'processDeleteRequest', 'watchdogStrandedPackets'];
const ALL_SEVEN = [...STAGE_A, ...STAGE_C];
const HORIZON_MS = 180_000;
// Stage-A stabilization before CLOSE: the deployed producers time out at 30s
// (REST-confirmed: ingest*/admin = 30s), plus a stated 90s propagation/recovery
// margin = 120s. CLOSE is refused until all three producer revisions match the
// intended build, that duration has elapsed since they were verified, a repeat
// check still shows the intended revisions, and no producer deploy is partial.
const STAGE_A_STABILIZE_SECONDS = Number(process.env.WB_STAGE_A_STABILIZE_SECONDS || 120);
const STAGE_A_PRODUCERS = ['ingestWbmPull', 'ingestWbmEdit', 'adminSubmitPullEdit'];
const JOURNAL_DIR = join(HERE, '.rollout-journal');

// ── args ──
const argv = process.argv.slice(2);
const mode = argv[0];
const flag = (k) => argv.includes(k);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const EXECUTE = flag('--execute');
const TARGET = opt('--target', 'emulator');            // 'emulator' | 'production'
const SHA = opt('--sha', null);
const PROJECT_ARG = opt('--project', null);
const EXPECT_STATE = opt('--expect-state', null);
const CONFIRM = opt('--confirm', null);
const ROLLOUT_ID = opt('--rollout-id', null);
const REASON = opt('--reason', 'wbm-canonical-rollout');
const CHANGED_BY = opt('--by', 'operator');
const HORIZON_SECONDS = Number(opt('--horizon-seconds', String(HORIZON_MS / 1000)));

const MODES = ['plan', 'preflight', 'stage-a', 'close', 'drain', 'stage-c', 'verify', 'reopen', 'status', 'resume'];
if (!MODES.includes(mode)) { console.error(`usage: wbmRolloutController.mjs <${MODES.join('|')}> [flags]`); process.exit(2); }

const log = (m) => console.log(m);
const die = (m, code = 1) => { console.error(`[controller] ${m}`); process.exit(code); };

// ── git / build / rules checks (read-only) ──
function gitHead() { return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); }
function gitBranch() { return execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); }
function worktreeClean() { return execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim() === ''; }
function builtExports() {
  const lib = join(ROOT, 'functions', 'lib', 'index.js').replace(/\\/g, '/');
  const out = execSync(`node -e "process.stdout.write(Object.keys(require('${lib}')).join(','))"`, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, FIREBASE_CONFIG: JSON.stringify({ projectId: PROJECT, databaseURL: `http://127.0.0.1:9/?ns=${PROJECT}` }), GCLOUD_PROJECT: PROJECT },
  });
  return new Set(out.split(','));
}
function rulesHashOk() {
  const fixture = join(ROOT, 'functions', 'emulator', 'fixtures', 'deployed-rules.json');
  if (!existsSync(fixture)) return { ok: false, detail: 'deployed-rules fixture missing' };
  const h = createHash('sha256').update(readFileSync(fixture)).digest('hex');
  return { ok: h === DEPLOYED_RULES_SHA256, detail: `${h.slice(0, 16)} vs ${DEPLOYED_RULES_SHA256.slice(0, 16)}` };
}
function gateImplemented() {
  const src = readFileSync(join(ROOT, 'functions', 'src', 'security', 'dashboardPullEdit.ts'), 'utf8');
  return src.includes('checkMutationAdmission');
}
function deployGuardAllows(command, sha) {
  try {
    execFileSync('node', [join(ROOT, 'functions', 'emulator', 'deployGuard.mjs'), command, '--expect-sha', sha], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch { return false; }
}
const stageCommand = (fns) => `firebase deploy --project ${PROJECT} --only ${fns.map((f) => `functions:${f}`).join(',')}`;

// ── read-only verification bundle ──
function readOnlyChecks() {
  const c = {};
  c.project = { ok: (PROJECT_ARG ?? PROJECT) === PROJECT, detail: PROJECT_ARG ?? '(default)' };
  const head = gitHead();
  // The integration branch, OR a detached HEAD pinned to the reviewed SHA (a
  // clean deployment worktree at the exact commit) — the SHA match is the
  // authoritative invariant, enforced separately by head/requireExecutionAuth.
  c.branch = { ok: gitBranch() === BRANCH || (gitBranch() === 'HEAD' && !!SHA && head === SHA), detail: gitBranch() };
  c.head = { ok: !SHA || SHA === head, detail: head, value: head };
  c.clean = { ok: worktreeClean(), detail: c => c };
  const ex = builtExports();
  const missing = ALL_SEVEN.filter((f) => !ex.has(f));
  c.sevenExports = { ok: missing.length === 0, detail: missing.length ? `missing ${missing}` : '7/7' };
  c.rules = rulesHashOk();
  c.gate = { ok: gateImplemented(), detail: 'checkMutationAdmission present' };
  c.stageAcmd = { ok: deployGuardAllows(stageCommand(STAGE_A), head), detail: stageCommand(STAGE_A) };
  c.stageCcmd = { ok: deployGuardAllows(stageCommand(STAGE_C), head), detail: stageCommand(STAGE_C) };
  return c;
}
function printChecks(c) {
  for (const [k, v] of Object.entries(c)) log(`  ${v.ok ? 'OK  ' : 'FAIL'} ${k.padEnd(13)} ${typeof v.detail === 'string' ? v.detail : ''}`);
  return Object.values(c).every((v) => v.ok);
}

// ── journal ──
function journalPath(id) { return join(JOURNAL_DIR, `${id}.json`); }
function loadJournal(id) { const p = journalPath(id); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }
function saveJournal(j) { mkdirSync(JOURNAL_DIR, { recursive: true }); writeFileSync(journalPath(j.rolloutId), JSON.stringify(j, null, 2)); }
function appendHistory(j, entry) { j.history = j.history || []; j.history.push({ ...entry, atLocalIso: nowIso() }); saveJournal(j); }
// Date.now()/new Date() are fine in a Node CLI (only Workflow scripts forbid them).
function nowIso() { return new Date().toISOString(); }

// ── db (target-scoped) ──
async function getDb() {
  const isEmu = TARGET === 'emulator';
  if (isEmu) process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002';
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || 'db'}/?ns=${PROJECT}-default-rtdb` });
  const adminMod = await import('firebase-admin');
  const admin = adminMod.default ?? adminMod;
  if (!admin.apps.length) admin.initializeApp();
  return { admin, db: admin.database() };
}
async function incomingEmpty(db) { return !(await db.ref('packets/incoming').once('value')).exists(); }
async function anyLock(db) {
  const w = (await db.ref('wells').once('value')).val() || {};
  return Object.values(w).some((x) => x?.status?.chronoLock);
}
async function watchdogKeys(db) {
  const inc = (await db.ref('packets/incoming').once('value')).val() || {};
  return Object.keys(inc).filter((k) => /_clone|_retrig/i.test(k));
}
// The three mutation triggers (processIncomingPull / processEditRequest /
// processDeleteRequest) all fire on packets/incoming/{packetId} and dispatch by
// requestType (proven from the trigger definitions). So the CREATE, EDIT and
// DELETE queues are one RTDB root; we still report each logical count and treat
// a coordinator lock as the in-flight-work marker.
async function sampleQuiescence(db) {
  const inc = (await db.ref('packets/incoming').once('value')).val() || {};
  const keys = Object.keys(inc);
  const byType = { create: 0, edit: 0, delete: 0, other: 0 };
  for (const k of keys) {
    const t = inc[k]?.requestType;
    if (t === 'edit') byType.edit++; else if (t === 'delete') byType.delete++; else if (t === undefined || t === 'pull') byType.create++; else byType.other++;
  }
  const clones = keys.filter((k) => /_clone|_retrig/i.test(k));
  const lock = await anyLock(db);
  const dirty = keys.length > 0 || lock || clones.length > 0;
  return { keys: keys.length, byType, clones: clones.length, lock, dirty };
}

// ── execution authorization ──
function requireExecutionAuth(j, expectState) {
  const reasons = [];
  if (!EXECUTE) reasons.push('missing --execute (dry-run)');
  if ((PROJECT_ARG ?? PROJECT) !== PROJECT) reasons.push(`project must be ${PROJECT}`);
  if (!SHA) reasons.push('missing --sha');
  else if (SHA !== gitHead()) reasons.push('--sha != git HEAD');
  else if (j && SHA !== j.reviewedSha) reasons.push('--sha != journal reviewedSha');
  if (!worktreeClean()) reasons.push('worktree dirty');
  if (!CONFIRM) reasons.push('missing --confirm token (run preflight)');
  else if (!j || CONFIRM !== j.confirmationToken) reasons.push('--confirm does not match the journal token');
  if (expectState !== null && EXPECT_STATE !== expectState) reasons.push(`--expect-state must be ${expectState} (got ${EXPECT_STATE ?? 'none'})`);
  if (TARGET === 'production' && process.env.WB_ROLLOUT_PROD_AUTHORIZED !== '1') reasons.push('production target requires WB_ROLLOUT_PROD_AUTHORIZED=1 (not set)');
  return reasons;
}
// Credentials presence WITHOUT reading/printing them.
function credentialsPresent() {
  if (TARGET === 'emulator') return true;
  return !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_TOKEN || process.env.GCLOUD_PROJECT);
}

async function casTransition(op, j, expectStatePrecond) {
  const authReasons = requireExecutionAuth(j, expectStatePrecond);
  if (!credentialsPresent()) authReasons.push('no credentials available for the target operation');
  if (authReasons.length) {
    log(`[controller] ${op.toUpperCase()} is a PLANNED (dry-run) action. To execute, satisfy:`);
    authReasons.forEach((r) => log(`   - ${r}`));
    log(`[controller] planned CAS: ${op} rolloutId=${j.rolloutId} sha=${j.reviewedSha.slice(0, 12)} target=${TARGET}`);
    return { executed: false };
  }
  // EXECUTE path (never reached in this engagement).
  const { admin, db } = await getDb();
  const { executeFlagTransition } = await import('./rolloutFlagCas.mjs');
  const intent = { op, rolloutId: j.rolloutId, reviewedSha: j.reviewedSha, changedBy: CHANGED_BY, reason: REASON };
  const res = await executeFlagTransition(admin, db, intent);
  appendHistory(j, { mode, op, outcome: res.outcome, reason: res.reason });
  return { executed: true, res };
}

// Force HELD_CLOSED on any post-close failure; never auto-reopen.
function heldClosed(j, why) {
  j.state = 'HELD_CLOSED';
  j.heldReason = why;
  appendHistory(j, { mode, event: 'HELD_CLOSED', why });
  console.error('\n[controller] ===== HELD_CLOSED =====');
  console.error(`[controller] ${why}`);
  console.error('[controller] Admission is LEFT CLOSED. The controller will NOT reopen automatically.');
  console.error('[controller] Recovery:');
  console.error('   1. node functions/tools/wbmRolloutController.mjs status --rollout-id ' + j.rolloutId);
  console.error('   2. Inventory live consumer revisions and packets/incoming + locks (read-only).');
  console.error('   3. Complete any missing forward Stage-C deploy, OR keep the gate closed.');
  console.error('   4. Only after a full `verify` passes may `reopen` be attempted.');
  console.error('   5. Never reopen on a CLI exit code alone.');
  process.exit(1);
}

// ─────────────────────────── modes ───────────────────────────
async function main() {
  if (mode === 'plan') {
    log('WB-M governed staged rollout — PLAN (nothing is executed)\n');
    log('Reviewed project : ' + PROJECT);
    log('Reviewed branch  : ' + BRANCH);
    log('Reviewed HEAD    : ' + gitHead());
    log('\nSequence (fail-closed state machine):');
    log('  preflight → stage-a → close → drain → (180s horizon) → stage-c → verify → reopen');
    log('\nStage A (gated producers):\n  ' + stageCommand(STAGE_A));
    log('\nStage C (canonical consumers):\n  ' + stageCommand(STAGE_C));
    log('\nAdmission flag (CAS): system/maintenance/wbmMutations');
    log('Horizon: 180s continuous-empty incoming + no lock + no new watchdog keys.');
    log('\nRead-only gate checks:');
    const ok = printChecks(readOnlyChecks());
    log(`\nPLAN ${ok ? 'CLEAN' : 'has FAILURES'}. Execution requires --execute + --project + --sha + --expect-state + --confirm + credentials.`);
    process.exit(ok ? 0 : 1);
  }

  if (mode === 'preflight') {
    const id = ROLLOUT_ID || `rollout-${gitHead().slice(0, 8)}`;
    log(`WB-M rollout PREFLIGHT — rolloutId ${id}\n`);
    const checks = readOnlyChecks();
    const ok = printChecks(checks);
    if (!ok) die('preflight FAILED — resolve the FAIL rows before minting a confirmation token', 1);
    const head = gitHead();
    // Confirmation token binds rolloutId + reviewed SHA + project (no secrets).
    const token = createHash('sha256').update(`${id}|${head}|${PROJECT}|preflight-v1`).digest('hex').slice(0, 24);
    const j = loadJournal(id) || { rolloutId: id, project: PROJECT, reviewedSha: head, createdIso: nowIso(), history: [] };
    j.reviewedSha = head; j.state = 'OPEN'; j.confirmationToken = token; j.stageA = j.stageA || {}; j.stageC = j.stageC || {};
    appendHistory(j, { mode, event: 'preflight_ok', head });
    saveJournal(j);
    log(`\nPreflight OK. Journal: ${journalPath(id)}`);
    log(`Confirmation token (bind to this rollout): ${token}`);
    log('Pass it to execute modes as: --confirm ' + token + ' --sha ' + head + ' --rollout-id ' + id);
    process.exit(0);
  }

  // All remaining modes need a journal.
  const id = ROLLOUT_ID || die('--rollout-id required for this mode (from preflight)');
  const j = loadJournal(id) || die(`no journal for rolloutId ${id} — run preflight first`);

  if (mode === 'status') {
    log(`Rollout ${id} — state ${j.state}  reviewedSha ${j.reviewedSha.slice(0, 12)}  target ${TARGET}`);
    log(`Journal: ${journalPath(id)}`);
    log('History:');
    (j.history || []).slice(-12).forEach((h) => log(`  ${h.atLocalIso}  ${h.mode || ''} ${h.event || h.op || ''} ${h.outcome || ''} ${h.reason || h.why || ''}`));
    try {
      const { db } = await getDb();
      log(`\nLive (${TARGET}) — incoming empty: ${await incomingEmpty(db)}, any lock: ${await anyLock(db)}`);
    } catch (e) { log(`\n(live read unavailable: ${e.message.split('\n')[0]})`); }
    process.exit(0);
  }

  if (mode === 'stage-a') {
    const cmd = stageCommand(STAGE_A);
    log('Stage A — gated producers. Guard check:');
    const allowed = deployGuardAllows(cmd, j.reviewedSha);
    log(`  deployGuard: ${allowed ? 'ALLOW' : 'REFUSE'}  ${cmd}`);
    if (!allowed) die('deploy guard refused the Stage-A command');
    // Record the producer revisions the operator observed live (read-only
    // describe) and open the stabilization window. --producer-revisions and
    // --producer-intended are fn->revision JSON maps for the three producers.
    const obsRaw = opt('--producer-revisions', null);
    const intRaw = opt('--producer-intended', null);
    if (obsRaw && intRaw) {
      const obs = JSON.parse(obsRaw); const intended = JSON.parse(intRaw);
      const missing = STAGE_A_PRODUCERS.filter((f) => !obs[f]);
      const mismatch = STAGE_A_PRODUCERS.filter((f) => obs[f] && intended[f] && obs[f] !== intended[f]);
      if (missing.length || mismatch.length) { appendHistory(j, { mode, event: 'stage_a_producers_partial', missing, mismatch }); die(`Stage-A producers not all on the intended revision (missing ${missing}, mismatch ${mismatch}) — partial deploy, do not proceed`); }
      const nowMs = Date.now();
      j.stageA = { producers: obs, intended, verifiedAtMs: nowMs, settleSeconds: STAGE_A_STABILIZE_SECONDS, settleDeadlineMs: nowMs + STAGE_A_STABILIZE_SECONDS * 1000 };
      j.state = 'OPEN'; appendHistory(j, { mode, event: 'stage_a_producers_verified', settleSeconds: STAGE_A_STABILIZE_SECONDS });
      log(`[controller] Stage-A producers verified on the intended revisions; stabilization window ${STAGE_A_STABILIZE_SECONDS}s started. CLOSE is refused until it elapses AND a repeat check still matches.`);
      process.exit(0);
    }
    // No producer revisions supplied → this is the plan/guard step. The DEPLOY
    // itself is the operator running the guarded command above; recording the
    // live producer revisions (a read-only describe) then re-running stage-a is
    // what opens the stabilization window.
    log('[controller] Stage-A deploy is PLANNED. Operator runs the guarded command above, then re-runs:');
    log('  stage-a --producer-revisions <live-describe> --producer-intended <reviewed> --sha <HEAD> --confirm <token> --rollout-id <id>');
    j.state = 'OPEN'; appendHistory(j, { mode, event: 'stage_a_planned' });
    process.exit(0);
  }

  if (mode === 'close') {
    if (j.state === 'HELD_CLOSED') die('rollout is HELD_CLOSED — reconcile via resume before any further action');
    // Stage-A stabilization gate: CLOSE is refused until the producers are
    // verified on the intended revisions, the stabilization duration has
    // elapsed, and a repeat revision check STILL matches (no partial/rollback).
    const sa = j.stageA;
    if (!sa?.settleDeadlineMs) die('CLOSE refused — run `stage-a` with --producer-revisions/--producer-intended first (producers not verified/stabilizing)');
    const remainingMs = sa.settleDeadlineMs - Date.now();
    if (remainingMs > 0) die(`CLOSE refused — Stage-A stabilization not elapsed (${Math.ceil(remainingMs / 1000)}s of ${sa.settleSeconds}s remaining)`);
    const recheckRaw = opt('--producer-revisions', null);
    if (!recheckRaw) die('CLOSE refused — pass --producer-revisions for the mandatory repeat revision check');
    const recheck = JSON.parse(recheckRaw);
    const stable = STAGE_A_PRODUCERS.every((f) => recheck[f] && recheck[f] === sa.producers[f]);
    if (!stable) die('CLOSE refused — repeat producer-revision check does NOT match the stabilized revisions (a producer changed/rolled — investigate)');
    j.stageA.recheckPassedMs = Date.now(); appendHistory(j, { mode, event: 'stage_a_stabilized_confirmed' });
    log('Close admission (atomic CAS)… (Stage-A stabilized + revisions re-confirmed)');
    try {
      const r = await casTransition('close', j, 'OPEN');
      if (!r.executed) { j.state = 'PAUSE_REQUESTED'; appendHistory(j, { mode, event: 'close_planned' }); process.exit(0); }
      if (r.res.outcome === 'refused') heldClosed(j, `CAS close refused: ${r.res.reason}`);
      j.state = 'DRAINING'; saveJournal(j);
      log(`[controller] admission CLOSED (${r.res.outcome}).`);
    } catch (e) { heldClosed(j, `exception during close: ${e.message.split('\n')[0]}`); }
    process.exit(0);
  }

  if (mode === 'drain') {
    if (j.state === 'HELD_CLOSED') die('HELD_CLOSED — reconcile first');
    log(`Drain + ${HORIZON_SECONDS}s CONTINUOUS-clean horizon across CREATE/EDIT/DELETE (packets/incoming), coordinator lock, and watchdog re-keys…`);
    let db;
    try { ({ db } = await getDb()); }
    catch (e) { log(`[controller] drain PLANNED (no live target: ${e.message.split('\n')[0]}). Would poll all roots for the horizon.`); j.state = 'PAUSE_REQUESTED'; appendHistory(j, { mode, event: 'drain_planned' }); process.exit(0); }
    const horizonMs = HORIZON_SECONDS * 1000;
    // The horizon must be met by CONTINUOUS cleanliness: ANY dirty sample RESETS
    // the clock (a queued EDIT/DELETE at second 179 restarts the full 180 s).
    // We give up (stay DRAINING → refuse) if we cannot achieve a clean horizon
    // within a bounded budget.
    const budgetMs = Number(process.env.WB_DRAIN_BUDGET_MS || horizonMs * 8);
    const overallStart = Date.now();
    let cleanSince = Date.now();
    let restarts = 0; let lastDirty = null;
    for (;;) {
      const s = await sampleQuiescence(db);
      if (s.dirty) { restarts++; lastDirty = { at: nowIso(), ...s }; cleanSince = Date.now(); }
      else if (Date.now() - cleanSince >= horizonMs) break; // clean for the full horizon
      if (Date.now() - overallStart > budgetMs) {
        j.state = 'DRAINING'; appendHistory(j, { mode, event: 'drain_not_reached', restarts, lastDirty });
        die(`drain did NOT reach a clean ${HORIZON_SECONDS}s horizon within budget (restarts=${restarts}, lastDirty=${JSON.stringify(lastDirty)}) — Stage C refused`);
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, horizonMs / 5)));
    }
    j.state = 'DRAINED_180'; j.horizonClearedIso = nowIso();
    appendHistory(j, { mode, event: 'drained_180', horizonSeconds: HORIZON_SECONDS, restarts });
    log(`[controller] DRAINED_180 — CREATE/EDIT/DELETE incoming empty, no coordinator lock, no watchdog re-key, CONTINUOUSLY for ${HORIZON_SECONDS}s (restarts during drain: ${restarts}).`);
    process.exit(0);
  }

  if (mode === 'stage-c') {
    if (j.state === 'HELD_CLOSED') die('HELD_CLOSED — reconcile first');
    if (j.state !== 'DRAINED_180') die(`refusing Stage C: state is ${j.state}, must be DRAINED_180 (drain + horizon first)`);
    const cmd = stageCommand(STAGE_C);
    const allowed = deployGuardAllows(cmd, j.reviewedSha);
    log(`Stage C — canonical consumers. deployGuard: ${allowed ? 'ALLOW' : 'REFUSE'}  ${cmd}`);
    if (!allowed) heldClosed(j, 'deploy guard refused the Stage-C command');
    const reasons = requireExecutionAuth(j, 'DRAINED_180');
    if (reasons.length || !EXECUTE) {
      log('[controller] Stage-C deploy is PLANNED (dry-run). Operator runs the guarded command above after satisfying:');
      reasons.forEach((r) => log(`   - ${r}`));
      j.state = 'DRAINED_180'; appendHistory(j, { mode, event: 'stage_c_planned' });
      process.exit(0);
    }
    heldClosed(j, 'production Stage-C execution is not authorized in this environment');
  }

  if (mode === 'verify') {
    if (j.state === 'HELD_CLOSED') die('HELD_CLOSED — reconcile first');
    log('Verify — 4 consumer revisions match intended, incoming empty, no lock…');
    let db; try { ({ db } = await getDb()); } catch (e) { die(`cannot reach target to verify: ${e.message.split('\n')[0]}`); }
    const empty = await incomingEmpty(db); const lock = await anyLock(db);
    // Revision proof: reconcile live consumer revisions against the intended set
    // (fail-closed; a CLI exit code is never trusted). --observed-revisions is a
    // JSON map fn->revision from a read-only `firebase functions:list`; --intended
    // -revisions likewise. When both are present we reconcile; otherwise we fall
    // back to a recorded proof flag (set by an executed stage-c).
    let revisionsProven = j.stageC?.revisionsProven === true;
    let reconcileNote = 'recorded proof flag';
    const observedRaw = opt('--observed-revisions', null);
    const intendedRaw = opt('--intended-revisions', j.stageC?.intended ? JSON.stringify(j.stageC.intended) : null);
    if (observedRaw && intendedRaw) {
      const { reconcileStageC } = require(join(ROOT, 'functions', 'lib', 'security', 'operational', 'stageCReconcile.js'));
      const rr = reconcileStageC({ intended: JSON.parse(intendedRaw), observed: JSON.parse(observedRaw), lookupOk: true });
      revisionsProven = rr.reopenAllowed;
      reconcileNote = rr.note;
      j.stageC = { ...(j.stageC || {}), lastReconcile: rr };
    }
    const allOk = empty && !lock && revisionsProven;
    log(`  incoming empty: ${empty}  no lock: ${!lock}  4-revisions proven: ${revisionsProven} (${reconcileNote})`);
    if (!allOk) { appendHistory(j, { mode, event: 'verify_incomplete', empty, lock, revisionsProven, reconcileNote }); die('verify incomplete — reopen is refused until all proofs hold'); }
    j.state = 'VERIFYING'; j.verifyPassed = true; appendHistory(j, { mode, event: 'verify_passed' });
    log('[controller] verify PASSED — reopen is now permitted (still requires full execution auth).');
    process.exit(0);
  }

  if (mode === 'reopen') {
    if (j.state === 'HELD_CLOSED') die('HELD_CLOSED — reconcile first; reopen refused');
    if (!j.verifyPassed) die('reopen refused — a full `verify` has not passed for this rollout');
    log('Reopen admission (atomic CAS, only after verify)…');
    try {
      const r = await casTransition('reopen', j, 'VERIFYING');
      if (!r.executed) { appendHistory(j, { mode, event: 'reopen_planned' }); process.exit(0); }
      if (r.res.outcome === 'refused') heldClosed(j, `CAS reopen refused: ${r.res.reason}`);
      j.state = 'OPEN'; appendHistory(j, { mode, event: 'reopened', outcome: r.res.outcome });
      log(`[controller] admission REOPENED (${r.res.outcome}).`);
    } catch (e) { heldClosed(j, `exception during reopen: ${e.message.split('\n')[0]}`); }
    process.exit(0);
  }

  if (mode === 'resume') {
    log(`Resume — reconciling rollout ${id} (state ${j.state}) fail-closed…`);
    // Never assume the last command was atomic. Inventory the live state.
    let db; try { ({ db } = await getDb()); } catch (e) { log(`(live read unavailable: ${e.message.split('\n')[0]})`); }
    if (db) {
      const empty = await incomingEmpty(db); const lock = await anyLock(db);
      log(`  live incoming empty: ${empty}  any lock: ${lock}`);
    }
    if (j.state === 'HELD_CLOSED') {
      log('  state is HELD_CLOSED. Admission stays CLOSED.');
      log('  To move forward: complete the missing Stage-C deploy (inventory revisions), run `verify`,');
      log('  and only then `reopen`. This tool will not reopen on a CLI exit code.');
    } else {
      log(`  resumable from ${j.state}. Re-run the next mode in sequence; each re-checks live state.`);
    }
    appendHistory(j, { mode, event: 'resume_inspected', state: j.state });
    process.exit(0);
  }
}
main().catch((e) => die(`fatal: ${e.message.split('\n')[0]}`, 2));
