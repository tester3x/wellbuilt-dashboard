/**
 * Lightweight unit checks for passcode helpers.
 * Run: npx --yes ts-node --transpile-only src/security/passcode.unit.test.ts
 * (from functions/) or after build: node lib/security/passcode.unit.test.js
 */
import {
  hashPasscodeScrypt,
  verifyPasscodeScrypt,
  normalizeDisplayName,
  legacySha256NamePasscode,
  validateRegistrationFields,
} from './passcode';

async function main() {
  let failed = 0;
  const assert = (cond: boolean, msg: string) => {
    if (!cond) {
      console.error('FAIL:', msg);
      failed++;
    } else {
      console.log('ok:', msg);
    }
  };

  assert(normalizeDisplayName('  Mike S24 ') === 'mike s24', 'normalize spaces/case');

  const rec = await hashPasscodeScrypt('secret99');
  assert(rec.algo === 'scrypt', 'algo scrypt');
  assert(await verifyPasscodeScrypt('secret99', rec) === true, 'verify good');
  assert(await verifyPasscodeScrypt('wrong', rec) === false, 'verify bad');

  const a = legacySha256NamePasscode('Mike', '1234');
  const b = legacySha256NamePasscode('mike', '1234');
  assert(a === b, 'legacy hash name case');
  assert(a.length === 64, 'legacy hex length');

  try {
    validateRegistrationFields({ displayName: 'ab', passcode: '12345' });
    assert(false, 'should reject short passcode');
  } catch {
    assert(true, 'rejects short passcode');
  }

  try {
    validateRegistrationFields({ displayName: 'wprjjg', passcode: 'abcdef' });
    assert(true, 'accepts 6-char name+pass');
  } catch (e) {
    assert(false, 'should accept valid ' + (e as Error).message);
  }

  // Demonstrate offline risk: short PIN space is tiny for legacy hash
  const name = 'mikes24';
  const target = legacySha256NamePasscode(name, '0000');
  let found = false;
  for (let i = 0; i < 10000; i++) {
    const pin = String(i).padStart(4, '0');
    if (legacySha256NamePasscode(name, pin) === target) {
      found = true;
      break;
    }
  }
  assert(found, 'legacy 4-digit PIN cracked in full space (offline risk demo)');

  if (failed) {
    console.error(`\n${failed} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll passcode unit checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
