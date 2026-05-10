#!/usr/bin/env node
// canonical_jobs backfill — Phase 1 SKELETON (DRY-RUN ONLY).
//
// This script intentionally REFUSES to make any writes. It exists as a
// scaffold so the backfill plan in backfill-canonical-jobs.md is concrete.
//
// To actually run a backfill (when approved):
//   1. Implement the three passes below (currently placeholders).
//   2. Add a real --commit flag handler with explicit operator
//      confirmation via readline.
//   3. Run with --dry-run first; review the per-pass report.
//   4. Only then run with --commit.
//
// Usage today:
//   node functions/scripts/backfill-canonical-jobs.mjs --dry-run
//
// This will print "skeleton — implement me" and exit 0.

import process from 'node:process';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const COMMIT = args.has('--commit');

if (COMMIT) {
  console.error(
    'REFUSED: --commit is not yet wired. Implement passes + readline ' +
      'confirmation first. See backfill-canonical-jobs.md for the plan.',
  );
  process.exit(2);
}

if (!DRY_RUN) {
  console.error('Pass --dry-run. This skeleton has no other execution mode yet.');
  process.exit(2);
}

console.log('canonical_jobs backfill — DRY RUN (skeleton).');
console.log('Phase 1 acceptance: this script is a plan placeholder.');
console.log('See backfill-canonical-jobs.md for the full plan.');
console.log('');
console.log('Pass 1 — Packets (RTDB → canonical_jobs):  not implemented');
console.log('Pass 2 — Tickets (Firestore → canonical_jobs):  not implemented');
console.log('Pass 3 — Transfer requests (Firestore):  not implemented');
console.log('');
console.log('Exiting 0 (no writes attempted).');
process.exit(0);
