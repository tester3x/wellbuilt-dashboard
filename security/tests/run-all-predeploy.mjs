/**
 * Orchestrates predeploy verification. Prefer:
 *   firebase emulators:exec --only auth,functions,firestore,database,storage --project demo-wb-sec "node security/tests/run-all-predeploy.mjs"
 */
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...opts.env },
  });
  if (r.status !== 0) {
    console.error(`Command failed: ${cmd} exit=${r.status}`);
    process.exit(r.status || 1);
  }
}

// Unit tests (compiled)
run('node', ['functions/lib/security/passcode.unit.test.js']);

// Rules adversarial
run('node', ['security/tests/rules-adversarial.test.mjs']);

// Callables
run('node', ['security/tests/callables-emulator.test.mjs']);

// Operational path hardening
run('node', ['security/tests/operational-emulator.test.mjs']);

console.log('\n=== ALL PREDEPLOY + OPERATIONAL EMULATOR TESTS PASSED ===\n');
