/**
 * JSA release gate — the EXACT checkpoint firestore.rules under the
 * emulator, plus a behavior-parity matrix against the deployed
 * production rules bytes.
 *
 * Proves, live:
 *   1. the checkpoint rules COMPILE (the emulator refuses bad rules at
 *      environment initialization);
 *   2. direct create/get/update/delete/list on jsa_governed_requests are
 *      denied for unauthenticated AND authenticated clients;
 *   3. legacy JSA/history behavior is unchanged (op-for-op parity with
 *      the deployed bytes);
 *   4. field shift-write behavior is unchanged: driver_shifts documents
 *      accept the same unauthenticated writes production accepts today —
 *      i.e. NO staged driver_shifts lockdown is present.
 *
 * Run:
 *   firebase emulators:exec --only firestore --project demo-wb-sec \
 *     "node security/tests/jsa-rules-gate.test.mjs"
 *
 * Optional: DEPLOYED_RULES_PATH=<file> enables the parity matrix against
 * the production bytes fetched from the live cloud.firestore release.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

let passed = 0;
let failed = 0;
const ok = (n) => { passed++; console.log(`  PASS  ${n}`); };
const bad = (n, e) => { failed++; console.error(`  FAIL  ${n}:`, e?.message || e); };
const gate = async (name, fn) => { try { await fn(); ok(name); } catch (e) { bad(name, e); } };

async function envFor(projectId, rulesPath) {
  return initializeTestEnvironment({
    projectId,
    firestore: {
      rules: readFileSync(rulesPath, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
}

/** Outcome label for one op under one context — used for parity. */
async function outcome(fn) {
  try { await fn(); return 'allowed'; } catch { return 'denied'; }
}

async function main() {
  console.log('\n=== JSA RULES RELEASE GATE ===\n');

  // 1. COMPILE — initialization throws on invalid rules.
  let env;
  await gate('checkpoint rules compile and load', async () => {
    env = await envFor('demo-wb-sec', resolve(root, 'firestore.rules'));
  });
  if (!env) { report(); process.exit(1); }

  const anon = env.unauthenticatedContext().firestore();
  const user = env.authenticatedContext('uid-1', { kind: 'driver' }).firestore();
  const RID = 'R'.repeat(43);

  // Seed a governed record via admin (bypasses rules) so read/update/
  // delete denials are tested against a REAL document, not a missing one.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'jsa_governed_requests', RID), {
      requestId: RID, state: 'pending',
    });
  });

  // 2. jsa_governed_requests — every direct client op denied.
  for (const [who, db] of [['unauthenticated', anon], ['authenticated', user]]) {
    await gate(`${who}: create jsa_governed_requests denied`,
      () => assertFails(setDoc(doc(db, 'jsa_governed_requests', 'C'.repeat(43)), { x: 1 })));
    await gate(`${who}: get jsa_governed_requests denied`,
      () => assertFails(getDoc(doc(db, 'jsa_governed_requests', RID))));
    await gate(`${who}: update jsa_governed_requests denied`,
      () => assertFails(updateDoc(doc(db, 'jsa_governed_requests', RID), { state: 'completed' })));
    await gate(`${who}: delete jsa_governed_requests denied`,
      () => assertFails(deleteDoc(doc(db, 'jsa_governed_requests', RID))));
    await gate(`${who}: list jsa_governed_requests denied`,
      () => assertFails(getDocs(collection(db, 'jsa_governed_requests'))));
  }

  // 4. Field shift writes — production behavior, NO staged lockdown.
  await gate('unauthenticated driver_shifts write is ALLOWED (no lockdown rides along)',
    () => assertSucceeds(setDoc(doc(anon, 'driver_shifts', 'driver-a_2026-08-13'), {
      currentShiftId: '2026-08-13_070000',
      events: [],
    })));
  await gate('unauthenticated driver_shifts read is ALLOWED (unchanged)',
    () => assertSucceeds(getDoc(doc(anon, 'driver_shifts', 'driver-a_2026-08-13'))));

  // 3. Legacy JSA/history behavior — op-for-op parity with the DEPLOYED
  //    bytes across every touched-or-adjacent surface.
  const deployedPath = process.env.DEPLOYED_RULES_PATH;
  if (deployedPath && existsSync(deployedPath)) {
    const prodEnv = await envFor('demo-wb-prod', resolve(deployedPath));
    const ops = (db) => ({
      'jsa_read_receipts get': () => getDoc(doc(db, 'jsa_read_receipts', RID)),
      'jsa_read_receipts unvalidated create': () => setDoc(doc(db, 'jsa_read_receipts', 'bad id'), { x: 1 }),
      'jsas get': () => getDoc(doc(db, 'jsas', 'j1')),
      'jsas create': () => setDoc(doc(db, 'jsas', 'j2'), { x: 1 }),
      'jsa_day_status get': () => getDoc(doc(db, 'jsa_day_status', 'd1')),
      'driver_shifts write': () => setDoc(doc(db, 'driver_shifts', 'driver-p_2026-08-13'), { currentShiftId: 'x_070000' }),
      'driver_shifts read': () => getDoc(doc(db, 'driver_shifts', 'driver-p_2026-08-13')),
      'tickets read': () => getDoc(doc(db, 'tickets', 't1')),
      'invoices read': () => getDoc(doc(db, 'invoices', 'i1')),
      'companies read': () => getDoc(doc(db, 'companies', 'liquid-gold')),
      'driver_shift_authority get': () => getDoc(doc(db, 'driver_shift_authority', 'driver-a')),
      'driver_credentials get': () => getDoc(doc(db, 'driver_credentials', 'driver-a')),
      'security_audit get': () => getDoc(doc(db, 'security_audit', 's1')),
    });
    const ckAnon = ops(anon);
    const prodAnon = ops(prodEnv.unauthenticatedContext().firestore());
    for (const name of Object.keys(ckAnon)) {
      const a = await outcome(ckAnon[name]);
      const b = await outcome(prodAnon[name]);
      await gate(`parity(${name}): checkpoint === deployed (${b})`, async () => {
        if (a !== b) throw new Error(`checkpoint=${a} deployed=${b}`);
      });
    }
    await prodEnv.cleanup();
  } else {
    console.log('  SKIP  parity matrix (DEPLOYED_RULES_PATH not set)');
  }

  await env.cleanup();
  report();
  process.exit(failed ? 1 : 0);
}

function report() {
  console.log(`\njsa rules gate: ${passed} passed, ${failed} failed`);
}

main().catch((e) => { console.error('GATE CRASH:', e); process.exit(1); });
