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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  suites: { only: 'database', script: 'cd functions && npx jest editTrail.emulator wbmPullCanonicalId.emulator editChronologicalPrecedence wbtGovernedOps --silent --runInBand --forceExit', env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8099' } },
};

const mode = MODES[process.argv[2]];
if (!mode) {
  console.error(`usage: node functions/emulator/run.mjs <${Object.keys(MODES).join('|')}>`);
  process.exit(2);
}

const cfgPath = join(ROOT, CONFIG);
if (!existsSync(cfgPath)) {
  console.error(`[run] refusing to launch: ${CONFIG} not found — never run harnesses against a default (production) config`);
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
console.log(`  project:   ${PROJECT} (emulator config ${CONFIG})`);
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

const isWin = process.platform === 'win32';
const args = ['firebase', 'emulators:exec', '--config', CONFIG, '--only', mode.only, '--project', PROJECT,
  // The exec script is ONE argument; the Windows shell needs it quoted.
  isWin ? `"${mode.script}"` : mode.script];
const child = spawn(
  isWin ? 'npx.cmd' : 'npx',
  args,
  {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, ...(mode.env || {}), JAVA_TOOL_OPTIONS: javaToolOptions, GCLOUD_PROJECT: PROJECT },
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
