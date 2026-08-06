/**
 * @wellbuilt/contracts conformance — run in THIS consumer against its
 * installed copy. Identical fixtures run in every app, so a period-logic
 * drift between WB-S, WB-T, WB-JSA and the Dashboard fails a test here
 * instead of stranding a driver (the 8/6 stale-shift failure was exactly
 * such a drift).
 *
 * Run: node tools/test-contractsConformance.mjs
 */
import { resolveWorkPeriod, isOperationallyOpen, mayBindRequestEvidence, assertContractCompatible, CONTRACT_VERSION } from '@wellbuilt/contracts';
import { CONFORMANCE_CASES } from '@wellbuilt/contracts/fixtures';

let pass = 0; const fail = [];
const check = (n, c) => { if (c) pass++; else fail.push(n); };

check('contract version handshake', CONTRACT_VERSION === 1);
for (const c of CONFORMANCE_CASES) {
  const r = resolveWorkPeriod(c.input);
  check(`${c.name} → ${c.expect.outcome}`, r.outcome === c.expect.outcome);
  if (c.expect.periodId) check(`${c.name} → ${c.expect.periodId}`, r.periodId === c.expect.periodId);
  if (['NO_ACTIVE_SHIFT','CLOSED_OR_SUPERSEDED','UNVERIFIED_OFFLINE','INVALID_CONFIGURATION'].includes(r.outcome)) {
    check(`${c.name}: never authorizes work`, !isOperationallyOpen(r) && !mayBindRequestEvidence(r));
  }
}
let threw = false; try { assertContractCompatible(999, 'consumer'); } catch { threw = true; }
check('unknown contract version refused', threw);

console.log(`contracts conformance: ${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach(f => console.log('  FAIL', f)); process.exitCode = 1; }
