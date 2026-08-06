/**
 * Dual-gate admin bootstrap core (vc51.9A6-C) — pure orchestration,
 * every effect injected, so the fail-closed lifecycle is fully
 * matrix-tested (tools/test-adminBootstrap.mjs) without credentials.
 *
 * Server authority = BOTH gates (functions/src/admin/authority.ts):
 *   1. verified custom claim  wellbuiltAdmin === true
 *   2. exact ENABLED platform_admins/{uid} record
 *
 * ENABLE ordering (every intermediate state denies):
 *   read → pending/disabled record → set claim → verify claim →
 *   enable record → verify BOTH gates via the real authorize decision
 * DISABLE ordering (denial is immediate):
 *   read → disable record FIRST → verify denial → remove only the
 *   wellbuiltAdmin claim → optional token revocation (explicit flag) →
 *   verify final state
 *
 * Dry-run is the default: without confirm, the plan is printed and the
 * deps' mutating functions are NEVER invoked. Reruns are idempotent.
 * An existing record with an unsupported policyVersion fails closed
 * before any write. Nothing here logs tokens, passwords, or keys —
 * only the UID, claim NAMES, and record state.
 */

export const CLAIM = 'wellbuiltAdmin';
export const POLICY_VERSION = 1;
export const RECORD_ACTOR = 'admin-bootstrap-tool';

/**
 * deps:
 *   getClaims(uid) → Promise<object>            (exact read, {} if none)
 *   setClaims(uid, claims) → Promise<void>
 *   getRecord(uid) → Promise<object|null>       (exact platform_admins read)
 *   setRecord(uid, fields) → Promise<void>      (field-merge write)
 *   revokeTokens(uid) → Promise<void>
 *   serverTimestamp() → unknown
 *   authorize(auth, record) → decision          (the REAL authorizeAdminCall)
 *   log(line) → void
 */

const names = (claims) => {
  const list = Object.keys(claims ?? {});
  return list.length ? list.join(', ') : '(none)';
};
const recordState = (record) =>
  record === null ? 'absent'
    : record.enabled === true ? `enabled(policy ${record.policyVersion})`
    : `disabled/pending(policy ${record.policyVersion})`;

function failClosedPolicy(record) {
  return record !== null
    && record.policyVersion !== undefined
    && record.policyVersion !== POLICY_VERSION;
}

export async function runEnable(deps, uid, { confirm = false } = {}) {
  // 1. Exact-read both gates.
  const claims = await deps.getClaims(uid);
  const record = await deps.getRecord(uid);
  deps.log(`target uid   : ${uid}`);
  deps.log(`claims now   : ${names(claims)}`);
  deps.log(`record now   : ${recordState(record)}`);

  if (failClosedPolicy(record)) {
    deps.log(`refused: existing record has unsupported policyVersion ${record.policyVersion} (tool supports ${POLICY_VERSION}); nothing written`);
    return { ok: false, state: 'unsupported-policy-version' };
  }

  // Idempotent rerun: both gates already hold and the REAL decision allows.
  if (claims[CLAIM] === true && record?.enabled === true) {
    const decision = deps.authorize({ uid, token: claims }, record);
    if (decision.ok) {
      deps.log('already enabled — both gates verified; nothing to do');
      return { ok: true, state: 'already-enabled' };
    }
  }

  if (!confirm) {
    deps.log('plan         : 1) record→pending/disabled  2) set claim  3) verify claim  4) enable record  5) verify both gates');
    deps.log('dry run — nothing written. Re-run with --confirm to apply.');
    return { ok: true, state: 'dry-run' };
  }

  // 2. Pending/disabled record BEFORE the claim exists.
  await deps.setRecord(uid, {
    enabled: false,
    policyVersion: POLICY_VERSION,
    ...(record === null ? { createdAt: deps.serverTimestamp(), createdBy: RECORD_ACTOR } : {}),
    updatedAt: deps.serverTimestamp(),
    updatedBy: RECORD_ACTOR,
  });
  deps.log('step 1/4     : record pending/disabled');

  // 3. Set the claim, preserving every unrelated claim.
  try {
    await deps.setClaims(uid, { ...claims, [CLAIM]: true });
  } catch (err) {
    deps.log(`FAILED setting claim: ${err?.message ?? err}`);
    deps.log('recovery     : record is pending/DISABLED — access stays denied. Fix Auth access and re-run enable.');
    return { ok: false, state: 'claim-set-failed-record-disabled' };
  }
  deps.log(`step 2/4     : claim ${CLAIM} set (unrelated claims preserved)`);

  // 4. Read back and verify the claim before ANY enable.
  const claimsAfter = await deps.getClaims(uid);
  if (claimsAfter[CLAIM] !== true) {
    deps.log('FAILED verifying claim after write.');
    deps.log('recovery     : record stays DISABLED — access denied. Re-run enable once Auth reads are consistent.');
    return { ok: false, state: 'claim-verify-failed-record-disabled' };
  }
  deps.log('step 3/4     : claim verified by read-back');

  // 5. Enable the record only AFTER the verified claim.
  try {
    await deps.setRecord(uid, {
      enabled: true,
      policyVersion: POLICY_VERSION,
      updatedAt: deps.serverTimestamp(),
      updatedBy: RECORD_ACTOR,
    });
  } catch (err) {
    deps.log(`FAILED enabling record: ${err?.message ?? err}`);
    deps.log('recovery     : claim is set but the record is DISABLED — access stays denied. Re-run enable.');
    return { ok: false, state: 'record-enable-failed-still-denied' };
  }
  deps.log('step 4/4     : record enabled');

  // 6. Verify BOTH gates with the real authorization decision.
  const finalClaims = await deps.getClaims(uid);
  const finalRecord = await deps.getRecord(uid);
  const decision = deps.authorize({ uid, token: finalClaims }, finalRecord);
  const preserved = Object.keys(claims).filter((k) => k !== CLAIM)
    .every((k) => k in finalClaims);
  deps.log(`claims after : ${names(finalClaims)}`);
  deps.log(`record after : ${recordState(finalRecord)}`);
  deps.log(`both gates   : ${decision.ok ? 'VERIFIED' : `NOT AUTHORIZED (${decision.reason})`} | unrelated claims preserved: ${preserved ? 'yes' : 'NO'}`);
  if (!decision.ok || !preserved) return { ok: false, state: 'final-verification-failed' };
  deps.log('The account must refresh its ID token before the claim reaches its session.');
  return { ok: true, state: 'enabled' };
}

export async function runDisable(deps, uid, { confirm = false, revokeTokens = false } = {}) {
  // 1. Exact-read current state.
  const claims = await deps.getClaims(uid);
  const record = await deps.getRecord(uid);
  deps.log(`target uid   : ${uid}`);
  deps.log(`claims now   : ${names(claims)}`);
  deps.log(`record now   : ${recordState(record)}`);

  // Idempotent rerun.
  if (claims[CLAIM] === undefined && (record === null || record.enabled !== true)) {
    deps.log('already disabled — neither gate holds; nothing to do');
    return { ok: true, state: 'already-disabled' };
  }

  if (!confirm) {
    deps.log(`plan         : 1) DISABLE record first  2) verify denial  3) remove ${CLAIM} only${revokeTokens ? '  4) revoke refresh tokens' : ''}`);
    deps.log('dry run — nothing written. Re-run with --confirm to apply.');
    return { ok: true, state: 'dry-run' };
  }

  // 2. Disable the record FIRST — denial is immediate on the next call.
  if (record !== null) {
    await deps.setRecord(uid, {
      enabled: false,
      disabledAt: deps.serverTimestamp(),
      updatedAt: deps.serverTimestamp(),
      updatedBy: RECORD_ACTOR,
    });
    deps.log('step 1/3     : record disabled (denial is immediate)');
  } else {
    deps.log('step 1/3     : no record exists — that gate already denies');
  }

  // 3. Verify the disabled state denies even with the claim still present.
  const midRecord = await deps.getRecord(uid);
  const midDecision = deps.authorize({ uid, token: claims }, midRecord);
  if (midDecision.ok) {
    deps.log('FAILED: record disable did not deny — aborting before claim work.');
    return { ok: false, state: 'record-disable-verify-failed' };
  }
  deps.log('step 2/3     : denial verified while claim still present');

  // 4. Remove ONLY the wellbuiltAdmin claim.
  const nextClaims = { ...claims };
  delete nextClaims[CLAIM];
  try {
    await deps.setClaims(uid, nextClaims);
  } catch (err) {
    deps.log(`FAILED removing claim: ${err?.message ?? err}`);
    deps.log('recovery     : the DISABLED record keeps access denied. Re-run disable to clear the claim.');
    return { ok: false, state: 'claim-removal-failed-still-denied' };
  }
  deps.log(`step 3/3     : claim ${CLAIM} removed (unrelated claims preserved)`);

  // 5. Optional token revocation — separate explicit flag only.
  if (revokeTokens) {
    await deps.revokeTokens(uid);
    deps.log('tokens       : refresh tokens revoked (--revoke-tokens)');
  }

  // 6. Verify final state.
  const finalClaims = await deps.getClaims(uid);
  const finalRecord = await deps.getRecord(uid);
  const decision = deps.authorize({ uid, token: finalClaims }, finalRecord);
  const preserved = Object.keys(claims).filter((k) => k !== CLAIM)
    .every((k) => k in finalClaims);
  deps.log(`claims after : ${names(finalClaims)}`);
  deps.log(`record after : ${recordState(finalRecord)}`);
  deps.log(`final        : ${!decision.ok && finalClaims[CLAIM] === undefined ? 'DISABLED verified' : 'VERIFICATION FAILED'} | unrelated claims preserved: ${preserved ? 'yes' : 'NO'}`);
  if (decision.ok || finalClaims[CLAIM] !== undefined || !preserved) {
    return { ok: false, state: 'final-verification-failed' };
  }
  return { ok: true, state: 'disabled' };
}
