#!/usr/bin/env node
// deployGuard.mjs — staged predeploy safety guard (rules-landmine + rollout
// defense). Validates a proposed `firebase deploy ...` command BEFORE the
// operator runs it. It NEVER deploys — prints ALLOW/REFUSE and exits non-zero
// on refuse. The safe rollout is TWO staged commands from ONE reviewed HEAD;
// any "deploy quickly" combined command is refused.
//
//   node functions/emulator/deployGuard.mjs '<firebase deploy command>' [--expect-sha <SHA>]
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT = 'wellbuilt-sync';

// The ONLY two accepted deploys, as exact function-name SETS.
const STAGE_A = ['ingestWbmPull', 'ingestWbmEdit', 'adminSubmitPullEdit'];      // gated producers
const STAGE_C = ['processIncomingPull', 'processEditRequest', 'processDeleteRequest', 'watchdogStrandedPackets']; // canonical consumers
const ALL_SEVEN = [...STAGE_A, ...STAGE_C];
const EXCLUDED = ['getGovernedWellConfig', 'staffHydrateCanonicalIdentity', 'staffRetireLegacyDriverLogin', 'recoverRejectedPull'];

const cmd = process.argv[2] || '';
const REVIEWED_SHA = process.argv.includes('--expect-sha') ? process.argv[process.argv.indexOf('--expect-sha') + 1] : null;
const refusals = [];
const refuse = (w) => refusals.push(w);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

// 1) Never rules / hosting / whole codebase / bare.
if (/\bdatabase\b/.test(cmd)) refuse('references `database` — would clobber the locked production rules with the OPEN local database.rules.json');
if (/\bhosting\b/.test(cmd)) refuse('references `hosting`');
if (/firebase\s+deploy\s*$/.test(cmd.trim())) refuse('bare `firebase deploy`');
if (/--only\s+functions\s*(--|$)/.test(cmd) || /--only\s+functions:dashboard\s*(--|$)/.test(cmd)) {
  refuse('whole-codebase functions deploy — would offer to DELETE the live functions absent from this branch');
}

// 2) Parse function targets.
const only = (cmd.match(/--only\s+(\S+)/) || [])[1] || '';
const fnTargets = only.split(',').filter((t) => t.startsWith('functions:')).map((t) => t.replace('functions:', ''));
if (only && /functions/.test(only) && fnTargets.length === 0) refuse('functions targeted without explicit function names');
for (const t of fnTargets) if (EXCLUDED.includes(t)) refuse(`excluded export present: ${t}`);

// 3) The target set must be EXACTLY Stage A or Stage C — never the combined 6/7.
let stage = null;
if (fnTargets.length) {
  if (sameSet(fnTargets, STAGE_A)) stage = 'A';
  else if (sameSet(fnTargets, STAGE_C)) stage = 'C';
  else if (sameSet(fnTargets, ALL_SEVEN)) refuse('SEVEN-function combined command — the rollout is STAGED (A then C); never deploy producers and consumers together');
  else if (sameSet(fnTargets, STAGE_C.concat(['ingestWbmPull', 'ingestWbmEdit']))) refuse('the old SIX-function combined command — superseded by the staged A/C protocol');
  else refuse(`target set is neither Stage A ${JSON.stringify(STAGE_A)} nor Stage C ${JSON.stringify(STAGE_C)}: ${JSON.stringify(fnTargets)}`);
}

// 4) Project must be exactly wellbuilt-sync.
const proj = (cmd.match(/--project\s+(\S+)/) || [])[1];
if (!proj) refuse('no --project (must be wellbuilt-sync)');
else if (proj !== PROJECT) refuse(`wrong project: ${proj}`);

// 5) One frozen reviewed HEAD, clean tree, and it must be THIS worktree.
try {
  const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (REVIEWED_SHA && head !== REVIEWED_SHA) refuse(`server HEAD ${head.slice(0, 12)} != reviewed ${REVIEWED_SHA.slice(0, 12)}`);
  if (execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim()) refuse('worktree is dirty');
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (branch !== 'integration/wbm-backdated-chrono-reconcile') refuse(`wrong branch: ${branch}`);
} catch { refuse('could not verify git HEAD/branch/cleanliness'); }

// 6) All SEVEN functions + the admission gate must exist in the built output at
//    this HEAD (same frozen source supplies both stages; gate implemented).
try {
  const lib = join(ROOT, 'functions', 'lib', 'index.js');
  if (!existsSync(lib)) refuse('functions/lib/index.js missing — run `npm --prefix functions run build` at the reviewed HEAD first');
  else {
    const built = execSync(`node -e "const m=Object.keys(require('${lib.replace(/\\/g, '/')}'));process.stdout.write(m.join(','))"`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, FIREBASE_CONFIG: JSON.stringify({ projectId: PROJECT, databaseURL: `http://127.0.0.1:9/?ns=${PROJECT}` }), GCLOUD_PROJECT: PROJECT } });
    const set = new Set(built.split(','));
    for (const f of ALL_SEVEN) if (!set.has(f)) refuse(`function ${f} not present in the built output at this HEAD`);
    const gate = execSync(`node -e "const s=require('fs').readFileSync('${join(ROOT, 'functions', 'src', 'security', 'dashboardPullEdit.ts').replace(/\\/g, '/')}','utf8');process.stdout.write(s.includes('checkMutationAdmission')?'gated':'ungated')"`, { cwd: ROOT, encoding: 'utf8' });
    if (gate !== 'gated') refuse('adminSubmitPullEdit is NOT gate-capable (missing checkMutationAdmission)');
  }
} catch { refuse('could not verify the built seven-function output / admission gate'); }

console.log(`[deployGuard] command: ${cmd}`);
console.log(`[deployGuard] stage: ${stage || '(none)'}   targets: ${fnTargets.join(', ') || '(none)'}`);
if (refusals.length === 0 && stage) {
  console.log(`[deployGuard] ALLOW — recognized STAGE ${stage} from the reviewed clean HEAD (all 7 fns built, gate present). Watch the CLI plan; abort on ANY deletion.`);
  process.exit(0);
}
if (refusals.length === 0 && !stage) refuse('no recognized stage command');
console.error('[deployGuard] REFUSE:');
for (const r of refusals) console.error(`  - ${r}`);
process.exit(1);
