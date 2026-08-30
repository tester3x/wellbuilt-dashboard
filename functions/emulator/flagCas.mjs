// flagCas.mjs — CAS admission-flag race harness (predeploy gate Rev-4 Blocker 2).
// Exercises the real executeFlagTransition (RTDB transaction) under contention
// and proves exactly one transition wins, stale/other-rollout/malformed inputs
// refuse, server time is authoritative, and committed transitions are
// idempotent on retry. Emulator only — no production write.
//
// RUN: node functions/emulator/run.mjs flagcas
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb` });
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();
const { executeFlagTransition, FLAG_PATH } = await import('../tools/rolloutFlagCas.mjs');

let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const val = async () => (await db.ref(FLAG_PATH).once('value')).val();
const SHA = 'dd5b3c538de10962fa96688c33c60ab60d1fcb3e';
const intent = (op, rolloutId, over = {}) => ({ op, rolloutId, reviewedSha: SHA, changedBy: 'op:test', reason: `${op}-${rolloutId}`, ...over });

async function reset(to = null) { await db.ref(FLAG_PATH).set(to); }

async function main() {
  // 1) Two operators CLOSE simultaneously → exactly one commits, one refuses.
  await reset(null);
  const [a, b] = await Promise.all([
    executeFlagTransition(admin, db, intent('close', 'A')),
    executeFlagTransition(admin, db, intent('close', 'B')),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  check('two simultaneous CLOSEs: exactly one commits, one refused', JSON.stringify(outcomes) === JSON.stringify(['committed', 'refused']), JSON.stringify([a.outcome, a.reason, b.outcome, b.reason]));
  const winner = a.outcome === 'committed' ? 'A' : 'B';
  check('the committed flag records the winning rolloutId', (await val())?.rolloutId === winner, JSON.stringify(await val()));
  check('authoritative changedAt is a server timestamp (number, not a workstation string)', typeof (await val())?.changedAt === 'number' && (await val()).changedAt > 1_600_000_000_000, JSON.stringify((await val())?.changedAt));

  // 2) Stale operator (other rollout) attempts REOPEN → refused.
  const st = await executeFlagTransition(admin, db, intent('reopen', winner === 'A' ? 'B' : 'A'));
  check('stale/other-rollout REOPEN refused (reopen_other_rollout)', st.outcome === 'refused' && st.reason === 'reopen_other_rollout', JSON.stringify([st.outcome, st.reason]));
  check('the flag is unchanged after a refused reopen (still CLOSED by winner)', (await val())?.paused === true && (await val())?.rolloutId === winner);

  // 3) Reopen under a DIFFERENT reviewed sha → refused.
  const shaMis = await executeFlagTransition(admin, db, intent('reopen', winner, { reviewedSha: 'other-sha' }));
  check('REOPEN under a different reviewed sha refused (reopen_sha_mismatch)', shaMis.outcome === 'refused' && shaMis.reason === 'reopen_sha_mismatch', JSON.stringify([shaMis.outcome, shaMis.reason]));

  // 4) Another rollout changes the flag between read and write → expectedPrior
  //    guard refuses (models a concurrent change the pure rule would otherwise allow).
  await reset(null);
  const observedPrior = await val(); // null (what an operator "read")
  await db.ref(FLAG_PATH).set({ paused: true, state: 'CLOSED', rolloutId: 'Z', reviewedSha: SHA, changedAt: 1, changedBy: 'op:z', reason: 'sneak' }); // someone else closes
  const guarded = await executeFlagTransition(admin, db, intent('close', 'A'), observedPrior);
  check('expectedPrior guard: a change between read and write is refused (unexpected_prior_value)', guarded.outcome === 'refused' && guarded.reason === 'unexpected_prior_value', JSON.stringify([guarded.outcome, guarded.reason]));

  // 5) Malformed flag appears → CLOSE refuses (never overwrite blindly).
  await db.ref(FLAG_PATH).set({ note: 'hand-edited', paused: 'nope' });
  const mal = await executeFlagTransition(admin, db, intent('close', 'A'));
  check('malformed flag: CLOSE refused (malformed_prior_value)', mal.outcome === 'refused' && mal.reason === 'malformed_prior_value', JSON.stringify([mal.outcome, mal.reason]));

  // 6) Retry after a committed CLOSE (same rollout) → noop, not a second write.
  await reset(null);
  const c1 = await executeFlagTransition(admin, db, intent('close', 'R'));
  const at1 = (await val())?.changedAt;
  const c2 = await executeFlagTransition(admin, db, intent('close', 'R'));
  check('retry after committed CLOSE (same rollout) → noop', c1.outcome === 'committed' && c2.outcome === 'noop' && c2.reason === 'already_closed_by_this_rollout', JSON.stringify([c1.outcome, c2.outcome, c2.reason]));
  check('noop retry does NOT rewrite the flag (changedAt unchanged)', (await val())?.changedAt === at1);

  // 7) Retry after a committed REOPEN (same rollout) → noop.
  const ro1 = await executeFlagTransition(admin, db, intent('reopen', 'R'));
  const ro2 = await executeFlagTransition(admin, db, intent('reopen', 'R'));
  check('reopen commits then retry → noop (connection-drop-after-commit safe)', ro1.outcome === 'committed' && ro2.outcome === 'noop' && ro2.reason === 'already_open_by_this_rollout', JSON.stringify([ro1.outcome, ro2.outcome]));
  check('after reopen the producer gate is OPEN again (paused:false)', (await val())?.paused === false);

  // 8) A burst of five concurrent CLOSEs → exactly one winner.
  await reset(null);
  const burst = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => executeFlagTransition(admin, db, intent('close', id))));
  const committed = burst.filter((r) => r.outcome === 'committed').length;
  check('five concurrent CLOSEs: exactly one winner, four refused', committed === 1 && burst.filter((r) => r.outcome === 'refused').length === 4, JSON.stringify(burst.map((r) => r.outcome)));

  console.log('\n=== CAS ADMISSION FLAG (real RTDB transaction races) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[flagCas] fatal', e); process.exit(2); });
