#!/usr/bin/env node
// run.mjs — safe launcher for the real-emulator harnesses.
//
//   node functions/emulator/run.mjs harness   → mutation matrix (harness.mjs)
//   node functions/emulator/run.mjs faults    → fault injection  (faults.mjs)
//   node functions/emulator/run.mjs ingest    → callable refusals (ingest.mjs)
//   node functions/emulator/run.mjs suites    → the four jest e2e suites
//
// WHY THE JVM FLAG: on Mike's Windows environment (confirmed there; not
// claimed universal), Selector.open() fails with "Unable to establish
// loopback connection" because the JDK selector wakeup pipe's AF_UNIX
// connect gets EINVAL when the socket file lives under the long default
// user temp path. Reproduction probe: a 3-line Selector.open() program
// (D:\tmp\SelTest.java). Fix: -Djdk.net.unixdomain.tmpdir=<short dir>
// (java.io.tmpdir alone does NOT work). This launcher validates/creates the
// short dir and APPENDS the flag to JAVA_TOOL_OPTIONS without clobbering
// anything already there. Non-Windows hosts skip the workaround entirely.
//
// Safety: refuses to run without the emulator config; never kills processes
// it did not start (emulators:exec owns its children); checks that the
// configured ports are free before launching; project id is pinned.
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = 'firebase.emulator.json';
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const SHORT_TMP = process.env.WB_EMU_SOCKET_TMP || 'C:\\t';

const MODES = {
  harness: { only: 'functions,database,firestore', script: 'node functions/emulator/harness.mjs' },
  faults: {
    only: 'functions,database,firestore',
    script: 'node functions/emulator/faults.mjs',
    env: {
      WB_FAULT_SPEC: 'crash_during_planning:fA;crash_before_commit:fB;crash_after_commit:fC;pause_before_transition:fS;crash_during_planning:wFresh;crash_during_planning:wNoAge;crash_before_commit:wClaim;crash_during_planning:wReceipt',
    },
  },
  ingest: { only: 'functions,database,firestore,auth', script: 'node functions/emulator/ingest.mjs' },
  gate: { only: 'functions,database,firestore,auth', script: 'node functions/emulator/gate.mjs' },
  admingate: { only: 'functions,database,firestore,auth', script: 'node functions/emulator/adminGate.mjs' },
  welldown: { only: 'functions,database,firestore,auth', script: 'node functions/emulator/wellDownThreeState.mjs' },
  equalorder: { only: 'functions,database', script: 'node functions/emulator/equalTimeArrivalOrder.mjs' },
  projpaths: { only: 'functions,database', script: 'node functions/emulator/projectionPaths.mjs' },
  contractfixture: { only: 'functions,database,firestore,auth', script: 'node functions/emulator/governedContractFixture.mjs' },
  adminedit: { only: 'functions,database,firestore', script: 'node functions/emulator/adminEditCompat.mjs' },
  mixed: { only: 'functions,database,firestore', script: 'node functions/emulator/mixedVersion.mjs' },
  rulesprobe: { only: 'database,auth', script: 'node functions/emulator/rulesprobe.mjs', config: 'firebase.rulesprobe.json' },
  flagcas: { only: 'database', script: 'node functions/emulator/flagCas.mjs' },
  controller: { only: 'database', script: 'node functions/emulator/controllerDemo.mjs' },
  stagea: { only: 'functions,database,firestore,auth', script: 'node functions/emulator/stageA.mjs', config: 'firebase.stageA.json', prep: 'stagea' },
  drainrace: { only: 'database', script: 'node functions/emulator/watchdogDrainRace.mjs', prep: 'stagea' },
  suites: { only: 'database', script: 'cd functions && npx jest editTrail.emulator wbmPullCanonicalId.emulator editChronologicalPrecedence wbtGovernedOps --silent --runInBand --forceExit', env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8099' } },
  // The live-trigger CREATE variant of the canonical-id e2e (the one skipped
  // under `suites` because it needs the functions emulator + WBM_FUNCTIONS_E2E).
  canonicalid: { only: 'functions,database,firestore', script: 'cd functions && npx jest wbmPullCanonicalId.emulator --runInBand --forceExit', env: { WBM_FUNCTIONS_E2E: '1', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8082' } },
};

// Stage-A prep: build the OLD (deployed, pre-chrono) consumers from commit
// c7378d6 into a throwaway worktree, junction node_modules so the mixed
// codebase resolves firebase-functions, and hand the harness + the codebase
// loader the absolute old-lib path via WB_OLD_LIB. Read-only w.r.t. the repo
// (a detached worktree; never deployed).
const OLD_CONSUMER_COMMIT = 'c7378d6';
function prepStageA(root) {
  // Honor a preset WB_OLD_LIB (e.g. the composite of exact DEPLOYED consumer
  // archives) — skip the c7378d6 rebuild and just point the codebase at it.
  if (process.env.WB_OLD_LIB && existsSync(process.env.WB_OLD_LIB)) {
    const cbNm = join(root, 'functions', 'emulator', 'stageA-codebase', 'node_modules');
    if (!existsSync(cbNm)) { try { execSync(`cmd /c mklink /J "${cbNm}" "${join(root, 'functions', 'node_modules')}"`, { stdio: 'pipe' }); } catch { /* exists */ } }
    writeFileSync(join(root, 'functions', 'emulator', 'stageA-codebase', '.old-lib.json'), JSON.stringify({ path: process.env.WB_OLD_LIB }));
    console.log(`[run] stagea prep: using PRESET WB_OLD_LIB → ${process.env.WB_OLD_LIB}`);
    return { WB_OLD_LIB: process.env.WB_OLD_LIB };
  }
  const wt = join(root, 'functions', 'emulator', '.stagea-old-consumers');
  const oldLib = join(wt, 'functions', 'lib', 'index.js');
  try {
    if (!existsSync(join(wt, 'functions', 'src', 'index.ts'))) {
      try { execSync(`git worktree add --detach "${wt}" ${OLD_CONSUMER_COMMIT}`, { cwd: root, stdio: 'pipe' }); }
      catch { execSync(`git worktree add --force --detach "${wt}" ${OLD_CONSUMER_COMMIT}`, { cwd: root, stdio: 'pipe' }); }
    }
    // Junction the old worktree's node_modules → the real functions/node_modules.
    const oldNm = join(wt, 'functions', 'node_modules');
    if (!existsSync(oldNm)) execSync(`cmd /c mklink /J "${oldNm}" "${join(root, 'functions', 'node_modules')}"`, { stdio: 'pipe' });
    // Junction the mixed codebase's node_modules too (CLI runtime detection).
    const cbNm = join(root, 'functions', 'emulator', 'stageA-codebase', 'node_modules');
    if (!existsSync(cbNm)) execSync(`cmd /c mklink /J "${cbNm}" "${join(root, 'functions', 'node_modules')}"`, { stdio: 'pipe' });
    if (!existsSync(oldLib)) {
      execSync(`"${join(root, 'functions', 'node_modules', '.bin', 'tsc.cmd')}" -p "${join(wt, 'functions', 'tsconfig.json')}"`, { stdio: 'pipe' });
    }
    if (!existsSync(oldLib)) throw new Error('old consumer lib did not build');
    // Hand the absolute old-lib path to the codebase loader via a file (the
    // emulator runtime does not inherit WB_OLD_LIB from this process).
    writeFileSync(join(root, 'functions', 'emulator', 'stageA-codebase', '.old-lib.json'), JSON.stringify({ path: oldLib }));
    console.log(`[run] stagea prep: OLD consumers built at ${OLD_CONSUMER_COMMIT} → ${oldLib}`);
    return { WB_OLD_LIB: oldLib };
  } catch (e) {
    console.error(`[run] stagea prep FAILED: ${e.message.split('\n')[0]}`);
    process.exit(2);
  }
}

const mode = MODES[process.argv[2]];
if (!mode) {
  console.error(`usage: node functions/emulator/run.mjs <${Object.keys(MODES).join('|')}>`);
  process.exit(2);
}

const activeConfig = mode.config || CONFIG;
const cfgPath = join(ROOT, activeConfig);
if (!existsSync(cfgPath)) {
  console.error(`[run] refusing to launch: ${activeConfig} not found — never run harnesses against a default (production) config`);
  process.exit(2);
}
const ports = Object.entries(JSON.parse(readFileSync(cfgPath, 'utf8')).emulators || {})
  .filter(([, v]) => v && typeof v === 'object' && 'port' in v)
  .map(([k, v]) => [k, v.port]);

// JVM workaround — Windows only; APPEND to existing JAVA_TOOL_OPTIONS.
let javaToolOptions = process.env.JAVA_TOOL_OPTIONS || '';
if (process.platform === 'win32') {
  try { mkdirSync(SHORT_TMP, { recursive: true }); } catch { /* exists */ }
  if (!existsSync(SHORT_TMP)) {
    console.error(`[run] cannot create the short AF_UNIX socket dir ${SHORT_TMP}`);
    process.exit(2);
  }
  if (!/jdk\.net\.unixdomain\.tmpdir/.test(javaToolOptions)) {
    javaToolOptions = `${javaToolOptions} -Djdk.net.unixdomain.tmpdir=${SHORT_TMP}`.trim();
  }
}

// Preflight report.
let javaVersion = 'unknown';
try { javaVersion = execSync('java -version 2>&1', { encoding: 'utf8' }).split('\n')[0].trim(); } catch { /* no java on PATH */ }
let cliVersion = 'unknown';
try { cliVersion = execSync('npx firebase --version', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* ignore */ }
console.log('[run] preflight');
console.log(`  os:        ${os.platform()} ${os.release()}`);
console.log(`  java:      ${javaVersion}`);
console.log(`  firebase:  ${cliVersion}`);
console.log(`  socketTmp: ${process.platform === 'win32' ? SHORT_TMP : '(not needed on this OS)'}`);
console.log(`  project:   ${PROJECT} (emulator config ${activeConfig})`);
console.log(`  ports:     ${ports.map(([k, p]) => `${k}:${p}`).join(' ')}`);

// Port availability: refuse rather than fight an unknown occupant.
async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}
for (const [name, port] of ports) {
  if (!(await portFree(port))) {
    console.error(`[run] port ${port} (${name}) is in use — refusing to launch (never kill an unknown process)`);
    process.exit(2);
  }
}

// Mode-specific prep (e.g. stagea builds the old consumer lib) → extra env.
const prepEnv = mode.prep === 'stagea' ? prepStageA(ROOT) : {};

const isWin = process.platform === 'win32';
const args = ['firebase', 'emulators:exec', '--config', activeConfig, '--only', mode.only, '--project', PROJECT,
  // The exec script is ONE argument; the Windows shell needs it quoted.
  isWin ? `"${mode.script}"` : mode.script];
const child = spawn(
  isWin ? 'npx.cmd' : 'npx',
  args,
  {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, ...(mode.env || {}), ...prepEnv, JAVA_TOOL_OPTIONS: javaToolOptions, GCLOUD_PROJECT: PROJECT },
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
