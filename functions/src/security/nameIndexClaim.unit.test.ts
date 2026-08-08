/**
 * vc51.9V — who may claim driver_name_index/{nameNorm}.
 *
 * Run: npx --yes ts-node --transpile-only src/security/nameIndexClaim.unit.test.ts
 * (from functions/) or after build: node lib/security/nameIndexClaim.unit.test.js
 *
 * THE DEFECT THIS GUARDS
 * adminSetDriverPasscode claimed the name index unconditionally:
 *
 *   await fs().collection('driver_name_index').doc(nameNorm).set({ driverId });
 *
 * So an authorized create/reset for one display name could silently
 * repoint another ACTIVE secure driver's name index at a different
 * driverId — that driver's next authenticateDriver would resolve to
 * someone else's credential record. adminApproveDriverRegistration
 * already guards this transactionally; adminSetDriverPasscode did not.
 *
 * The decision is extracted here so all four outcomes are provable
 * without a Firestore emulator, and so "unreadable" is an explicit
 * refusal rather than an accident of control flow.
 */
import {
  decideNameIndexClaim,
  readIncumbentCredential,
  readIndexOwner,
} from './nameIndexClaim';

async function main() {
  let failed = 0;
  const assert = (cond: boolean, msg: string) => {
    if (!cond) {
      console.error('FAIL:', msg);
      failed++;
    } else {
      console.log('PASS:', msg);
    }
  };

  const TARGET = 'new-uuid-1111';
  const OTHER = 'other-uuid-2222';

  // 1. absent index → allow
  {
    const d = decideNameIndexClaim({
      existingDriverId: null,
      targetDriverId: TARGET,
      incumbentCredential: 'absent',
    });
    assert(d.allow === true && d.reason === 'absent', 'absent index allows the claim');
  }

  // 2. index already ours → idempotent allow
  {
    const d = decideNameIndexClaim({
      existingDriverId: TARGET,
      targetDriverId: TARGET,
      incumbentCredential: 'active',
    });
    assert(d.allow === true && d.reason === 'same_driver',
      'reclaiming our own index is idempotent');
  }

  // 3. index points at an identity with NO credential record — a legacy or
  //    orphaned binding. Intentional replacement.
  {
    const d = decideNameIndexClaim({
      existingDriverId: OTHER,
      targetDriverId: TARGET,
      incumbentCredential: 'absent',
    });
    assert(d.allow === true && d.reason === 'incumbent_missing',
      'an orphaned/legacy index may be replaced');
  }

  // 4. index points at a DEACTIVATED secure identity → obsolete, replaceable
  {
    const d = decideNameIndexClaim({
      existingDriverId: OTHER,
      targetDriverId: TARGET,
      incumbentCredential: 'inactive',
    });
    assert(d.allow === true && d.reason === 'incumbent_inactive',
      'a deactivated secure identity may be replaced');
  }

  // 5. THE HIJACK: index points at another ACTIVE secure driver → refuse
  {
    const d = decideNameIndexClaim({
      existingDriverId: OTHER,
      targetDriverId: TARGET,
      incumbentCredential: 'active',
    });
    assert(d.allow === false && d.reason === 'name_taken',
      'an active secure driver\'s name index is never repointed');
  }

  // 6. unreadable incumbent → refuse rather than guess
  {
    const d = decideNameIndexClaim({
      existingDriverId: OTHER,
      targetDriverId: TARGET,
      incumbentCredential: 'unreadable',
    });
    assert(d.allow === false && d.reason === 'indeterminate',
      'an unreadable incumbent refuses rather than guessing');
  }

  // 7. an unreadable incumbent that is OURS is still fine — identity matches
  //    before the credential is ever consulted.
  {
    const d = decideNameIndexClaim({
      existingDriverId: TARGET,
      targetDriverId: TARGET,
      incumbentCredential: 'unreadable',
    });
    assert(d.allow === true && d.reason === 'same_driver',
      'our own index does not depend on reading the credential');
  }

  // 8. the decision never depends on the passcode or any credential material.
  //    Comments legitimately NAME that material to explain why it is absent,
  //    so assert against executable code only.
  {
    const raw = require('fs').readFileSync(
      require('path').join(__dirname, 'nameIndexClaim.ts'), 'utf8') as string;
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(!/passcode|scrypt|token/i.test(code),
      'the claim decision touches no credential material');
    assert(!/console\./.test(code), 'the claim decision logs nothing');
  }

  // ── malformed ownership state ──────────────────────────────────────────
  {
    assert(readIndexOwner(false, undefined) === null, 'a missing index doc is absent');
    assert(readIndexOwner(true, {}) === 'malformed',
      'an index doc with no driverId is malformed, not free');
    assert(readIndexOwner(true, { driverId: 42 }) === 'malformed',
      'a non-string driverId is malformed');
    assert(readIndexOwner(true, { driverId: '' }) === 'malformed',
      'an empty driverId is malformed');
    assert(readIndexOwner(true, { driverId: '   ' }) === 'malformed',
      'a whitespace driverId is malformed');
    assert(readIndexOwner(true, { driverId: OTHER }) === OTHER,
      'a well-formed owner is returned');

    const d = decideNameIndexClaim({
      existingDriverId: 'malformed',
      targetDriverId: TARGET,
      incumbentCredential: 'absent',
    });
    assert(d.allow === false && d.reason === 'malformed_owner',
      'a malformed index owner refuses rather than being overwritten');
  }

  // ── malformed credential `active` ──────────────────────────────────────
  {
    assert(readIncumbentCredential(false, undefined) === 'absent',
      'no credential doc is absent');
    assert(readIncumbentCredential(true, { active: false }) === 'inactive',
      'active:false is inactive');
    assert(readIncumbentCredential(true, { active: true }) === 'active',
      'active:true is active');
    assert(readIncumbentCredential(true, {}) === 'active',
      'a missing active field defaults to ACTIVE, never inactive');
    for (const bad of ['false', 0, 1, null, {}, []]) {
      assert(readIncumbentCredential(true, { active: bad }) === 'unreadable',
        `active=${JSON.stringify(bad)} is uninterpretable, not inactive`);
    }
    // and an uninterpretable incumbent must refuse the claim
    const d = decideNameIndexClaim({
      existingDriverId: OTHER,
      targetDriverId: TARGET,
      incumbentCredential: readIncumbentCredential(true, { active: 'false' }),
    });
    assert(d.allow === false && d.reason === 'indeterminate',
      'a string "false" never hands away a live login name');
  }

  // ── ordering pins on the callable ──────────────────────────────────────
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'driverAuthCallables.ts'), 'utf8') as string;
    const start = src.indexOf('export const adminSetDriverPasscode');
    const end = src.indexOf('export const', start + 10);
    const body = src.slice(start, end === -1 ? undefined : end);

    assert(!/await rtdb\(\)\.ref\(`drivers\/profiles\/\$\{driverId\}`\)\.set\(/.test(
      body.slice(0, body.indexOf('runTransaction'))),
      'no profile is written before the ownership claim');
    assert(!/await rtdb\(\)\.ref\(`drivers\/approved\/\$\{data\.legacyHash\}`\)\.update\(/.test(
      body.slice(0, body.indexOf('runTransaction'))),
      'no legacy record is mutated before the ownership claim');
    assert(/pendingProfile/.test(body) && /pendingLegacyLink/.test(body),
      'RTDB writes are deferred into payloads');

    const uuidIdx = body.indexOf('randomUUID()');
    assert(uuidIdx > -1 && uuidIdx < body.indexOf('runTransaction'),
      'the candidate driverId is minted ONCE outside the transaction callback');
    assert(!/runTransaction\(async \(tx\) => \{[\s\S]*?randomUUID\(\)/.test(body),
      'no UUID is generated inside a retryable transaction callback');

    const auditIdx = body.indexOf("action: 'adminSetDriverPasscode'");
    assert(auditIdx > body.indexOf('runTransaction'),
      'the success audit is written only after the transaction');
    assert(/adminSetDriverPasscode_fail/.test(body),
      'a compensating failure emits its own audit, not the success one');
    assert(/driver_credentials'\)\.doc\(driverId\)\.delete\(\)/.test(body),
      'a failed profile write compensates by removing the credential');
  }

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall name-index claim checks passed');
  }
}

void main();
