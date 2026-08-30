#!/usr/bin/env node
// deployGuard.mjs — predeploy safety guard (rules-landmine defense). Validates
// a proposed `firebase deploy ...` command string BEFORE the operator runs it,
// and refuses anything that could clobber the locked production rules, delete
// live functions, target the wrong project, or run from a dirty/wrong tree.
// It NEVER deploys — it prints ALLOW/REFUSE and exits non-zero on refuse.
//
//   node functions/emulator/deployGuard.mjs 'firebase deploy --only functions:processIncomingPull,...' [--expect-sha <SHA>]
import { execSync } from 'node:child_process';

const APPROVED = new Set([
  'processIncomingPull', 'processEditRequest', 'processDeleteRequest',
  'watchdogStrandedPackets', 'ingestWbmPull', 'ingestWbmEdit',
  // Add adminSubmitPullEdit here ONLY if the gated version is deliberately in
  // the reviewed manifest (Blocker-3). Left out by default.
]);
const PROJECT = 'wellbuilt-sync';
const REVIEWED_SHA = process.argv.includes('--expect-sha')
  ? process.argv[process.argv.indexOf('--expect-sha') + 1]
  : null;

const cmd = process.argv[2] || '';
const refusals = [];
const refuse = (why) => refusals.push(why);

// 1) Never touch rules / hosting / whole codebase.
if (/\bdatabase\b/.test(cmd)) refuse('command references `database` — would clobber the locked production rules with the OPEN local database.rules.json');
if (/\bhosting\b/.test(cmd)) refuse('command references `hosting`');
if (/firebase\s+deploy\s*$/.test(cmd.trim())) refuse('bare `firebase deploy` — deploys rules + hosting + every codebase');
if (/--only\s+functions\s*(--|$)/.test(cmd) || /--only\s+functions:dashboard\s*(--|$)/.test(cmd)) {
  refuse('whole-codebase functions deploy — would offer to DELETE the 31 live functions absent from this branch');
}

// 2) Every function target must be in the approved allowlist.
const only = (cmd.match(/--only\s+(\S+)/) || [])[1] || '';
const fnTargets = only.split(',').filter((t) => t.startsWith('functions:')).map((t) => t.replace('functions:', ''));
if (only && fnTargets.length === 0 && /functions/.test(only)) refuse('functions targeted without explicit function names');
for (const t of fnTargets) {
  if (!APPROVED.has(t)) refuse(`function target not in the approved allowlist: ${t}`);
}
// 3) Explicitly-excluded new exports must never appear.
for (const bad of ['getGovernedWellConfig', 'staffHydrateCanonicalIdentity', 'staffRetireLegacyDriverLogin', 'recoverRejectedPull']) {
  if (fnTargets.includes(bad)) refuse(`excluded export present: ${bad}`);
}

// 4) Project must be exactly wellbuilt-sync.
const proj = (cmd.match(/--project\s+(\S+)/) || [])[1];
if (proj && proj !== PROJECT) refuse(`wrong project: ${proj}`);
if (!proj) refuse('no --project given (must be wellbuilt-sync)');

// 5) Server HEAD must be the reviewed SHA (if provided) and the worktree clean.
try {
  const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  if (REVIEWED_SHA && head !== REVIEWED_SHA) refuse(`server HEAD ${head.slice(0, 12)} != reviewed ${REVIEWED_SHA.slice(0, 12)}`);
  const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (dirty) refuse('worktree is dirty');
} catch { refuse('could not verify git HEAD/cleanliness'); }

console.log(`[deployGuard] command: ${cmd}`);
console.log(`[deployGuard] function targets: ${fnTargets.join(', ') || '(none)'}`);
if (refusals.length === 0) {
  console.log('[deployGuard] ALLOW — targets are within the approved allowlist; still watch the CLI plan and abort on any deletion.');
  process.exit(0);
}
console.error('[deployGuard] REFUSE:');
for (const r of refusals) console.error(`  - ${r}`);
process.exit(1);
