// rolloutFlagCas.mjs — compare-and-set executor for the WB-M admission flag
// (predeploy gate Rev-4 Blocker 2). Wraps the pure decideFlagTransition in an
// RTDB transaction so the prior value it judges is the COMMITTED one and
// exactly one transition wins under contention. The authoritative changedAt is
// a SERVER timestamp, never the workstation clock. This module performs a write
// ONLY when actually invoked with a live db by an authorized caller; it is
// imported by both the emulator race harness and the rollout controller.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { decideFlagTransition } = require(join(HERE, '..', 'lib', 'security', 'operational', 'rolloutFlagTransition.js'));

export const FLAG_PATH = 'system/maintenance/wbmMutations';

/**
 * Execute one CAS transition. Returns
 *   { outcome:'committed'|'noop'|'refused', reason, value }
 * `outcome:'committed'` means this call wrote the flag; 'noop' means it was
 * already in the target end-state for this rollout (safe idempotent retry);
 * 'refused' means the transition was not allowed (flag left unchanged).
 *
 * `expectedPrior`, when provided, is an extra fail-closed guard: if the value
 * observed in the transaction is not deep-equal to it, the transition refuses
 * (defends against an unexpected concurrent change the pure rule would allow).
 */
export async function executeFlagTransition(admin, db, intent, expectedPrior) {
  const ref = db.ref(FLAG_PATH);
  const SENTINEL = admin.database.ServerValue.TIMESTAMP;
  const box = { outcome: 'refused', reason: 'unset', value: undefined };
  const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  // Warm the local cache so the transaction's first callback sees real data.
  await ref.once('value');

  // The RTDB transaction callback can be invoked with a stale `null` before the
  // server value arrives; returning `undefined` (abort) there would prematurely
  // refuse a legitimate transition. So we NEVER return undefined — refuse/noop
  // leave the value UNCHANGED (return the exact arg), which lets RTDB re-run the
  // callback against the real server value and converge. `box` reflects the last
  // (authoritative) call; the CAS guarantee comes from RTDB re-validating a
  // changed write and re-running the callback.
  await ref.transaction((current) => {
    if (expectedPrior !== undefined && !eq(current, expectedPrior)) {
      box.outcome = 'refused'; box.reason = 'unexpected_prior_value'; return current;
    }
    const d = decideFlagTransition(current ?? null, intent);
    if (d.decision === 'commit') {
      box.outcome = 'committed'; box.reason = 'ok';
      return { ...d.next, changedAt: SENTINEL };
    }
    if (d.decision === 'noop') { box.outcome = 'noop'; box.reason = d.reason; return current; }
    box.outcome = 'refused'; box.reason = d.reason; return current; // leave unchanged
  }, undefined, false);

  // Read back the committed value (resolves the server timestamp); never trust
  // the local sentinel object as the value.
  box.value = (await ref.once('value')).val();
  return box;
}
