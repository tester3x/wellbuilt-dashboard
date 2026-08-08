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
  decideCompensation,
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
    assert(/tx\.delete\(credRef\)/.test(body),
      'a failed profile write compensates by removing the credential');
  }

  // ── compensation ownership: A must never unwind B's newer state ────────
  {
    const MY_OP = 'op-A-1111';
    const base = { myOpId: MY_OP, myDriverId: TARGET };

    // 1. untouched -> full cleanup
    {
      const d = decideCompensation({
        ...base,
        credentialExists: true, credentialOpId: MY_OP,
        indexExists: true, indexDriverId: TARGET,
      });
      assert(d.deleteCredential && d.releaseIndex && !d.superseded,
        '1. untouched state is fully cleaned up');
    }

    // 2. credential superseded by a newer op -> touch nothing
    {
      const d = decideCompensation({
        ...base,
        credentialExists: true, credentialOpId: 'op-B-2222',
        indexExists: true, indexDriverId: TARGET,
      });
      assert(!d.deleteCredential && !d.releaseIndex && d.superseded,
        '2. a newer credential is never deleted, and its index is kept');
    }

    // 3. index superseded (points elsewhere) -> do not release it
    {
      const d = decideCompensation({
        ...base,
        credentialExists: true, credentialOpId: MY_OP,
        indexExists: true, indexDriverId: OTHER,
      });
      assert(!d.releaseIndex && d.superseded,
        '3. an index pointing elsewhere is never released');
      assert(d.deleteCredential, '3. our own orphaned credential is still removed');
    }

    // 4. both superseded -> change nothing
    {
      const d = decideCompensation({
        ...base,
        credentialExists: true, credentialOpId: 'op-B-2222',
        indexExists: true, indexDriverId: OTHER,
      });
      assert(!d.deleteCredential && !d.releaseIndex && d.superseded,
        '4. fully superseded state is left entirely alone');
    }

    // 5. a same-driver RESET by B advances the marker -> survives A's cleanup
    {
      const d = decideCompensation({
        ...base,
        credentialExists: true, credentialOpId: 'op-B-reset',
        indexExists: true, indexDriverId: TARGET,
      });
      assert(!d.deleteCredential,
        '5. a same-driver reset is never erased by an earlier create');
      assert(!d.releaseIndex,
        '5. the index the reset depends on is retained');
    }

    // 5b. driverChangeOwnPasscode CLEARS the marker (partial update) —
    //     an absent opId must not match ours.
    {
      const d = decideCompensation({
        ...base,
        credentialExists: true, credentialOpId: undefined,
        indexExists: true, indexDriverId: TARGET,
      });
      assert(!d.deleteCredential,
        '5b. a cleared marker never matches, so a self-service change survives');
    }

    // 6. idempotent retry: after a successful cleanup there is nothing left
    {
      const d = decideCompensation({
        ...base,
        credentialExists: false, credentialOpId: undefined,
        indexExists: false, indexDriverId: undefined,
      });
      assert(!d.deleteCredential && !d.releaseIndex && !d.superseded,
        '6. re-running compensation is a no-op, not a false supersession');
    }

    // 6b. credential already gone but our index remains -> release it
    {
      const d = decideCompensation({
        ...base,
        credentialExists: false, credentialOpId: undefined,
        indexExists: true, indexDriverId: TARGET,
      });
      assert(d.releaseIndex && !d.deleteCredential,
        '6b. an index with no credential behind it is released');
    }

    // 8. the marker is not credential-derived
    {
      const src = require('fs').readFileSync(
        require('path').join(__dirname, 'nameIndexClaim.ts'), 'utf8') as string;
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert(!/passcode|scrypt|salt|token/i.test(code),
        '8. the operation marker carries no credential-derived material');
    }
    // a non-string marker can never establish ownership
    {
      for (const bad of [undefined, null, 42, {}, []]) {
        const d = decideCompensation({
          ...base,
          credentialExists: true, credentialOpId: bad,
          indexExists: true, indexDriverId: TARGET,
        });
        assert(!d.deleteCredential,
          `a ${JSON.stringify(bad)} marker never proves ownership`);
      }
    }
  }

  // ── 7/9/10. callable-level pins ────────────────────────────────────────
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'driverAuthCallables.ts'), 'utf8') as string;

    assert(/const opId = randomUUID\(\);/.test(src),
      'the operation marker is generated once per invocation');
    // Scope to adminSetDriverPasscode: an unscoped search spans earlier
    // callables' transactions and reports a false positive.
    {
      const s = src.indexOf('export const adminSetDriverPasscode');
      const e = src.indexOf('export const', s + 10);
      const setBody = src.slice(s, e === -1 ? undefined : e);
      const opIdx = setBody.indexOf('const opId = randomUUID');
      const txIdx = setBody.indexOf('runTransaction');
      assert(opIdx > -1 && txIdx > -1 && opIdx < txIdx,
        'the marker is generated before, not inside, the transaction');
      assert(!/runTransaction\([\s\S]*?randomUUID\(\)/.test(setBody),
        'the marker is not regenerated inside a retryable transaction');
    }
    assert(/decideCompensation\(\{/.test(src)
      && !/collection\('driver_credentials'\)\.doc\(driverId\)\.delete\(\);\n\s*await fs\(\)\.runTransaction/.test(src),
      '7. compensation is transactional, not an unconditional delete');
    assert(/opId: FieldValue\.delete\(\)/.test(src),
      '5. driverChangeOwnPasscode clears the marker so a self-service change survives');

    // 9. authentication must never consult the marker.
    const authStart = src.indexOf('export const authenticateDriver');
    const authEnd = src.indexOf('export const', authStart + 10);
    const authBody = src.slice(authStart, authEnd);
    assert(!/opId/.test(authBody),
      '9. authenticateDriver never reads the cleanup marker');

    // 7. a failed cleanup must not report success.
    assert(/compensated = false/.test(src)
      && /cleanup failed; identity may be partially created/.test(src),
      '7. a failed compensation reports honestly rather than a clean failure');
    assert(/superseded/.test(src),
      'a superseded cleanup is reported distinctly from a clean one');
  }

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall name-index claim checks passed');
  }
}

void main();
