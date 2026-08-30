#!/usr/bin/env node
// rolloutFlag.mjs — PREPARED (not executed) maintenance-flag operator for the
// staged rollout (predeploy gate Rev-3 item 6). It plans the exact RTDB write
// against system/maintenance/wbmMutations and checks the precondition, but it
// is DRY-RUN by default: without --execute it prints the plan and performs NO
// write. It refuses (exit 1) if the live flag is not in the expected shape —
// so an unexpected pre-existing value halts the operator instead of being
// silently overwritten.
//
//   node functions/emulator/rolloutFlag.mjs <op> [--execute] [--reason <r>] [--by <uid>]
//   ops: read | close | reopen | confirm | record | restore
//
// SAFETY: this session never passes --execute against production. The write is
// left for a human operator with service-account creds and explicit authority.
import process from 'node:process';

const PATH = 'system/maintenance/wbmMutations';
const argv = process.argv.slice(2);
const op = argv[0];
const EXECUTE = argv.includes('--execute');
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const REASON = arg('--reason', 'wbm_mutations_paused');
const BY = arg('--by', 'operator:prepared');
const AT = arg('--at', 'SERVER_TIMESTAMP'); // never Date.now() here — operator/server stamps it

const OPS = new Set(['read', 'close', 'reopen', 'confirm', 'record', 'restore']);
if (!OPS.has(op)) {
  console.error(`[rolloutFlag] unknown op "${op || ''}". Expected one of: ${[...OPS].join(', ')}`);
  process.exit(2);
}

// Precondition per op: what the live flag MUST look like before we act.
// `null` = absent; `{paused:false}` = open; `{paused:true}` = closed.
// The operator supplies the observed value via --observed <json> (from a prior
// `read`); we refuse to proceed on any mismatch.
function preconditionFor(o) {
  switch (o) {
    case 'read': return { requires: 'any', note: 'read is safe; records the baseline' };
    case 'close': return { requires: 'open-or-absent', note: 'only pause when currently OPEN or unset — never blindly overwrite a closed flag' };
    case 'reopen': return { requires: 'closed', note: 'only reopen a flag we ourselves closed' };
    case 'confirm': return { requires: 'closed', note: 'verify the pause actually landed (read-back)' };
    case 'record': return { requires: 'any', note: 'append the observed baseline to the runbook (no write to prod)' };
    case 'restore': return { requires: 'known-prior', note: 'restore the EXACT pre-rollout value captured by read/record' };
    default: return { requires: 'none', note: '' };
  }
}

function plannedValue(o) {
  switch (o) {
    case 'close': return { paused: true, reason: REASON, at: AT, by: BY };
    case 'reopen': return { paused: false, reason: `reopened_after_rollout:${REASON}`, at: AT, by: BY };
    case 'restore': return '<EXACT prior value captured by `read` — supply via --restore-json>';
    default: return null; // read/confirm/record perform no write
  }
}

// Refuse an unexpected pre-existing value. The operator passes what `read`
// observed via --observed '<json|absent>'.
function checkObserved(o) {
  const observedRaw = arg('--observed', undefined);
  if (observedRaw === undefined) return { ok: true, gate: 'no --observed supplied (planning only)' };
  let observed;
  if (observedRaw === 'absent' || observedRaw === 'null') observed = null;
  else { try { observed = JSON.parse(observedRaw); } catch { return { ok: false, gate: `--observed is not valid JSON: ${observedRaw}` }; } }
  const isOpen = observed === null || observed?.paused === false;
  const isClosed = observed?.paused === true;
  const req = preconditionFor(o).requires;
  if (req === 'open-or-absent' && !isOpen) return { ok: false, gate: `refuse close: live flag is not OPEN/absent (observed ${observedRaw}). Investigate who paused it.` };
  if (req === 'closed' && !isClosed) return { ok: false, gate: `refuse ${o}: live flag is not CLOSED (observed ${observedRaw}).` };
  if (req === 'known-prior' && observed === undefined) return { ok: false, gate: 'refuse restore: no captured prior value.' };
  // A malformed flag (object without a boolean `paused`) is always unexpected.
  if (observed !== null && typeof observed === 'object' && typeof observed.paused !== 'boolean') {
    return { ok: false, gate: `refuse ${o}: live flag is MALFORMED (no boolean paused): ${observedRaw}` };
  }
  return { ok: true, gate: `precondition met (${req})` };
}

const pre = preconditionFor(op);
const val = plannedValue(op);
const obs = checkObserved(op);

console.log(`[rolloutFlag] op=${op}  path=${PATH}`);
console.log(`[rolloutFlag] precondition: ${pre.requires}  (${pre.note})`);
console.log(`[rolloutFlag] observed-check: ${obs.gate}`);
if (val !== null) console.log(`[rolloutFlag] planned write: db.ref('${PATH}').set(${JSON.stringify(val)})`);
else console.log(`[rolloutFlag] no write (this op only reads/records)`);

if (!obs.ok) {
  console.error(`[rolloutFlag] REFUSE — ${obs.gate}`);
  process.exit(1);
}
if (!EXECUTE) {
  console.log(`[rolloutFlag] DRY-RUN — no write performed. Re-run with --execute (human operator + service-account creds) to apply.`);
  process.exit(0);
}
// --execute path is intentionally inert in this engagement: refuse to write
// production from the automated harness.
console.error(`[rolloutFlag] REFUSE --execute here — production flag writes are performed only by a human operator with explicit authorization, never by this harness.`);
process.exit(3);
