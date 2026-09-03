import {
  decideSubmit,
  decideClaim,
  decideApplyOutcome,
  decideReconcile,
  rejectExhausted,
  claimTransactionUpdate,
  outcomeTransactionUpdate,
  rejectExhaustedTransactionUpdate,
  resolveAbsentOriginalStatus,
  wbmEditV3OpPath,
  WBM_EDIT_V3_OPS_PATH,
  V3_MAX_APPLY_ATTEMPTS,
  V3_CLAIM_TIMEOUT_MS,
  type WbmEditV3Op,
  type SubmitIncoming,
} from '../wbmEditV3Lane';

const T0 = 1_788_000_000_000;

const incoming = (over: Partial<SubmitIncoming> = {}): SubmitIncoming => ({
  editEventId: 'editevt_g4',
  originalPacketId: '20260902_155609_Gabriel4_nhyxyo',
  wellName: 'Gabriel 4',
  companyId: 'liquid-gold',
  driverId: '2cad521c',
  digest: 'digest-A',
  editedFields: ['bblsTaken'],
  payload: { bblsTaken: 170, editEventId: 'editevt_g4' },
  ...over,
});

const opFrom = (over: Partial<WbmEditV3Op> = {}): WbmEditV3Op => {
  const d = decideSubmit({ existing: null, incoming: incoming(), nowMs: T0 });
  if (d.action !== 'create') throw new Error('setup');
  return { ...d.op, ...over };
};

describe('wbmEditV3Lane — path helpers', () => {
  test('op path is under the dedicated v3 namespace, never packets/incoming', () => {
    expect(wbmEditV3OpPath('editevt_g4')).toBe('wbmEdits/v3/ops/editevt_g4');
    expect(WBM_EDIT_V3_OPS_PATH.startsWith('wbmEdits/v3')).toBe(true);
    expect(wbmEditV3OpPath('x')).not.toContain('packets/incoming');
  });
});

describe('decideSubmit — durable-first, idempotent acceptance', () => {
  test('new id → create an accepted op; acceptance is the op the caller commits', () => {
    const d = decideSubmit({ existing: null, incoming: incoming(), nowMs: T0 });
    expect(d.action).toBe('create');
    if (d.action !== 'create') return;
    expect(d.op.status).toBe('accepted');
    expect(d.op.acceptedAt).toBe(T0);
    expect(d.op.attempts).toBe(0);
    expect(d.op.digest).toBe('digest-A');
    expect(d.op.editedFields).toEqual(['bblsTaken']);
    expect(d.response).toEqual({ ok: true, status: 'accepted', editEventId: 'editevt_g4' });
  });

  test('CONCURRENCY: same id + same digest (double Save / retry) → resume, NO second op', () => {
    const existing = opFrom({ status: 'applied', appliedAt: T0 + 5 });
    const d = decideSubmit({ existing, incoming: incoming(), nowMs: T0 + 100 });
    expect(d.action).toBe('resume');
    expect(d.response).toEqual({ ok: true, status: 'applied', editEventId: 'editevt_g4', idempotent: true });
  });

  test('CONCURRENCY: same id + same digest while still applying → resume current status', () => {
    const existing = opFrom({ status: 'applying', claimedAt: T0 + 1 });
    const d = decideSubmit({ existing, incoming: incoming(), nowMs: T0 + 2 });
    expect(d.action).toBe('resume');
    expect(d.response.status).toBe('applying');
    expect(d.response.idempotent).toBe(true);
  });

  test('CONCURRENCY: same id + DIFFERENT digest → permanent idempotency_conflict, existing untouched', () => {
    const existing = opFrom({ status: 'accepted' });
    const d = decideSubmit({ existing, incoming: incoming({ digest: 'digest-B', payload: { bblsTaken: 999 } }), nowMs: T0 + 1 });
    expect(d.action).toBe('reject_conflict');
    expect(d.response.ok).toBe(false);
    expect(d.response.reason).toBe('idempotency_conflict');
    // No mutated op is returned — the existing durable op is never overwritten.
    expect((d as { op?: unknown }).op).toBeUndefined();
  });
});

describe('decideClaim — single-claim accepted→applying', () => {
  test('accepted → claimable → applying', () => {
    const c = decideClaim(opFrom({ status: 'accepted' }), T0 + 10);
    expect(c.claim).toBe(true);
    if (!c.claim) return;
    expect(c.next.status).toBe('applying');
    expect(c.next.claimedAt).toBe(T0 + 10);
  });

  test('applied/rejected → never reclaimed', () => {
    expect(decideClaim(opFrom({ status: 'applied' }), T0 + 10)).toEqual({ claim: false, reason: 'already_terminal' });
    expect(decideClaim(opFrom({ status: 'rejected' }), T0 + 10)).toEqual({ claim: false, reason: 'already_terminal' });
  });

  test('fresh applying by another worker → NOT reclaimed (single-claim)', () => {
    const c = decideClaim(opFrom({ status: 'applying', claimedAt: T0 }), T0 + 1000);
    expect(c).toEqual({ claim: false, reason: 'inflight_fresh' });
  });

  test('dead applying (claim older than timeout) → reclaimable', () => {
    const c = decideClaim(opFrom({ status: 'applying', claimedAt: T0 }), T0 + V3_CLAIM_TIMEOUT_MS + 1);
    expect(c.claim).toBe(true);
  });

  test('retry_wait not yet due → not claimed; due → claimed', () => {
    const op = opFrom({ status: 'retry_wait', retryWaitUntil: T0 + 5000, attempts: 1 });
    expect(decideClaim(op, T0 + 4999)).toEqual({ claim: false, reason: 'retry_not_due' });
    expect(decideClaim(op, T0 + 5001).claim).toBe(true);
  });

  test('missing op → not claimable', () => {
    expect(decideClaim(null, T0)).toEqual({ claim: false, reason: 'missing' });
  });
});

describe('decideApplyOutcome — trail-verified applied, else never silently lost', () => {
  const applying = () => opFrom({ status: 'applying', claimedAt: T0, attempts: 0 });

  test('apply ok + trail verified → applied (with beforeAfter captured)', () => {
    const next = decideApplyOutcome({ op: applying(), trailVerified: true, error: null, permanent: false, beforeAfter: { bblsTaken: { previous: 150, next: 170 } }, nowMs: T0 + 20 });
    expect(next.status).toBe('applied');
    expect(next.appliedAt).toBe(T0 + 20);
    expect(next.trailVerified).toBe(true);
    expect(next.beforeAfter).toEqual({ bblsTaken: { previous: 150, next: 170 } });
    expect(next.attempts).toBe(1);
  });

  test('SAFETY: apply "ok" but trail ABSENT (already_done-without-trail) → retry_wait, not applied', () => {
    const next = decideApplyOutcome({ op: applying(), trailVerified: false, error: null, permanent: false, nowMs: T0 + 20 });
    expect(next.status).toBe('retry_wait');
    expect(next.lastError).toBe('trail_verification_failed');
    expect(next.retryWaitUntil).toBeGreaterThan(T0 + 20);
  });

  test('transient error → retry_wait with backoff', () => {
    const next = decideApplyOutcome({ op: applying(), trailVerified: false, error: 'contended', permanent: false, nowMs: T0 });
    expect(next.status).toBe('retry_wait');
    expect(next.lastError).toBe('contended');
  });

  test('permanent error → rejected immediately (durable trace)', () => {
    const next = decideApplyOutcome({ op: applying(), trailVerified: false, error: 'ownership_denied', permanent: true, nowMs: T0 });
    expect(next.status).toBe('rejected');
    expect(next.rejectReason).toBe('ownership_denied');
    expect(next.rejectedAt).toBe(T0);
  });

  test('exhausting attempts → durable rejected max_retries, NEVER a silent vanish', () => {
    let op = opFrom({ status: 'applying', claimedAt: T0, attempts: V3_MAX_APPLY_ATTEMPTS - 1 });
    const next = decideApplyOutcome({ op, trailVerified: false, error: null, permanent: false, nowMs: T0 });
    expect(next.status).toBe('rejected');
    expect(next.rejectReason).toBe('max_retries:trail_verification_failed');
    expect(next.attempts).toBe(V3_MAX_APPLY_ATTEMPTS);
  });
});

describe('decideReconcile — bounded, never drops', () => {
  test('accepted (worker missed) → redrive', () => {
    expect(decideReconcile(opFrom({ status: 'accepted' }), T0 + 10)).toBe('redrive');
  });
  test('fresh applying → skip; dead applying → redrive', () => {
    expect(decideReconcile(opFrom({ status: 'applying', claimedAt: T0 }), T0 + 1000)).toBe('skip');
    expect(decideReconcile(opFrom({ status: 'applying', claimedAt: T0 }), T0 + V3_CLAIM_TIMEOUT_MS + 1)).toBe('redrive');
  });
  test('retry_wait due with attempts left → redrive; exhausted → reject_exhausted', () => {
    expect(decideReconcile(opFrom({ status: 'retry_wait', retryWaitUntil: T0, attempts: 1 }), T0 + 1)).toBe('redrive');
    expect(decideReconcile(opFrom({ status: 'retry_wait', retryWaitUntil: T0, attempts: V3_MAX_APPLY_ATTEMPTS }), T0 + 1)).toBe('reject_exhausted');
  });
  test('applied/rejected → skip', () => {
    expect(decideReconcile(opFrom({ status: 'applied' }), T0)).toBe('skip');
    expect(decideReconcile(opFrom({ status: 'rejected' }), T0)).toBe('skip');
  });
  test('rejectExhausted produces a durable terminal reason', () => {
    const r = rejectExhausted(opFrom({ status: 'retry_wait', lastError: 'contended', attempts: 5 }), T0 + 9);
    expect(r.status).toBe('rejected');
    expect(r.rejectReason).toBe('max_retries:contended');
    expect(r.rejectedAt).toBe(T0 + 9);
  });
});

describe('TRANSACTION AUDIT — claimTransactionUpdate (admin-SDK null-first-run safety)', () => {
  const preAccepted = () => opFrom({ status: 'accepted' });

  test('null-first-run (cur=null) resolves against the SERVER-read op → claims (fixes the stall)', () => {
    const out = claimTransactionUpdate(null, preAccepted(), T0 + 5);
    expect(out?.status).toBe('applying');
    expect(out?.claimedAt).toBe(T0 + 5);
  });

  test('true server value on re-run drives the decision: cur=accepted → claims', () => {
    expect(claimTransactionUpdate(opFrom({ status: 'accepted' }), preAccepted(), T0 + 5)?.status).toBe('applying');
  });

  test('NO DOUBLE CLAIM: cur=applying (fresh, another worker) → abort (undefined)', () => {
    const cur = opFrom({ status: 'applying', claimedAt: T0 + 1 });
    expect(claimTransactionUpdate(cur, preAccepted(), T0 + 2)).toBeUndefined();
  });

  test('NO TERMINAL OVERWRITE/RESURRECTION: cur=applied → abort; cur=rejected → abort', () => {
    expect(claimTransactionUpdate(opFrom({ status: 'applied' }), preAccepted(), T0 + 9)).toBeUndefined();
    expect(claimTransactionUpdate(opFrom({ status: 'rejected' }), preAccepted(), T0 + 9)).toBeUndefined();
  });

  test('retry_wait respected: not-due cur → abort; due cur → claim', () => {
    const notDue = opFrom({ status: 'retry_wait', retryWaitUntil: T0 + 5000, attempts: 1 });
    expect(claimTransactionUpdate(notDue, notDue, T0 + 4999)).toBeUndefined();
    const due = opFrom({ status: 'retry_wait', retryWaitUntil: T0, attempts: 1 });
    expect(claimTransactionUpdate(due, due, T0 + 1)?.status).toBe('applying');
  });

  test('dead applying (stale claim past timeout) is reclaimable', () => {
    const dead = opFrom({ status: 'applying', claimedAt: T0 });
    expect(claimTransactionUpdate(dead, dead, T0 + V3_CLAIM_TIMEOUT_MS + 1)?.status).toBe('applying');
  });
});

describe('TRANSACTION AUDIT — outcomeTransactionUpdate (only our live claim writes)', () => {
  const claimed = () => opFrom({ status: 'applying', claimedAt: T0 + 10, attempts: 0 });
  const nextApplied = (op: WbmEditV3Op) => decideApplyOutcome({ op, trailVerified: true, error: null, permanent: false, nowMs: T0 + 20 });

  test('cur = our own applying (same claimedAt) → writes the outcome', () => {
    const op = claimed();
    const out = outcomeTransactionUpdate(op, op, nextApplied(op));
    expect(out?.status).toBe('applied');
  });

  test('null-first-run → resolves against our claimedOp → writes the outcome', () => {
    const op = claimed();
    expect(outcomeTransactionUpdate(null, op, nextApplied(op))?.status).toBe('applied');
  });

  test('NO STALE REPLACEMENT: cur reclaimed by another worker (different claimedAt) → abort', () => {
    const op = claimed();
    const reclaimed = { ...op, claimedAt: T0 + 999 };
    expect(outcomeTransactionUpdate(reclaimed, op, nextApplied(op))).toBeUndefined();
  });

  test('NO TERMINAL OVERWRITE: cur already applied/rejected → abort', () => {
    const op = claimed();
    expect(outcomeTransactionUpdate(opFrom({ status: 'applied' }), op, nextApplied(op))).toBeUndefined();
    expect(outcomeTransactionUpdate(opFrom({ status: 'rejected' }), op, nextApplied(op))).toBeUndefined();
  });
});

describe('TRANSACTION AUDIT — rejectExhaustedTransactionUpdate', () => {
  const known = () => opFrom({ status: 'retry_wait', lastError: 'contended', attempts: V3_MAX_APPLY_ATTEMPTS });

  test('exhausted retry_wait → durable reject', () => {
    const out = rejectExhaustedTransactionUpdate(known(), known(), T0 + 3);
    expect(out?.status).toBe('rejected');
    expect(out?.rejectReason).toBe('max_retries:contended');
  });

  test('null-first-run → rejects against the known op', () => {
    expect(rejectExhaustedTransactionUpdate(null, known(), T0 + 3)?.status).toBe('rejected');
  });

  test('NEVER abort an in-flight worker: cur=applying → undefined (let the worker finish)', () => {
    expect(rejectExhaustedTransactionUpdate(opFrom({ status: 'applying', claimedAt: T0 }), known(), T0 + 3)).toBeUndefined();
  });

  test('NO TERMINAL OVERWRITE: cur=applied/rejected → undefined', () => {
    expect(rejectExhaustedTransactionUpdate(opFrom({ status: 'applied' }), known(), T0 + 3)).toBeUndefined();
    expect(rejectExhaustedTransactionUpdate(opFrom({ status: 'rejected' }), known(), T0 + 3)).toBeUndefined();
  });
});

describe('TRANSACTION AUDIT — concurrent worker + reconciler cannot double-apply', () => {
  test('two workers race the claim: exactly one wins; the loser aborts', () => {
    const pre = opFrom({ status: 'accepted' });
    // Worker A claims first (server was accepted).
    const a = claimTransactionUpdate(pre, pre, T0 + 1)!;
    expect(a.status).toBe('applying');
    // Worker B's transaction re-runs with the TRUE server value (A's applying).
    const b = claimTransactionUpdate(a, pre, T0 + 2);
    expect(b).toBeUndefined(); // B cannot double-claim
    // A applies and writes its outcome; B (had it applied) would see A's live claim.
    const nextA = decideApplyOutcome({ op: a, trailVerified: true, error: null, permanent: false, nowMs: T0 + 3 });
    expect(outcomeTransactionUpdate(a, a, nextA)?.status).toBe('applied');
    // The reconciler, seeing the now-applied op, cannot reject or re-drive it.
    expect(rejectExhaustedTransactionUpdate(opFrom({ status: 'applied' }), a, T0 + 4)).toBeUndefined();
    expect(decideReconcile(opFrom({ status: 'applied' }), T0 + 5)).toBe('skip');
  });
});

describe('end-to-end lifecycle (pure)', () => {
  test('accepted → applying → applied is the happy path with exactly one op', () => {
    // submit
    const s = decideSubmit({ existing: null, incoming: incoming(), nowMs: T0 });
    if (s.action !== 'create') throw new Error();
    let op = s.op;
    // worker claim
    const c = decideClaim(op, T0 + 1);
    if (!c.claim) throw new Error();
    op = c.next;
    expect(op.status).toBe('applying');
    // apply + verify
    op = decideApplyOutcome({ op, trailVerified: true, error: null, permanent: false, nowMs: T0 + 2 });
    expect(op.status).toBe('applied');
    // a late duplicate submit resumes, does not fork
    const dup = decideSubmit({ existing: op, incoming: incoming(), nowMs: T0 + 3 });
    expect(dup.action).toBe('resume');
  });
});

describe('resolveAbsentOriginalStatus — un-appliable (rejected) vs not-yet-landed', () => {
  const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
  const rejectedNode = (over = {}) => ({
    reason: 'STALE_PULL_TIME',
    packet: { driverId: DRIVER, companyId: 'liquid-gold', wellName: 'Gabriel 5' },
    ...over,
  });

  test('rejected original owned by the caller → TERMINAL rejected with reason', () => {
    const r = resolveAbsentOriginalStatus(rejectedNode(), DRIVER);
    expect(r.terminal).toBe('rejected');
    if (r.terminal === 'rejected') expect(r.reason).toBe('original_rejected: STALE_PULL_TIME');
  });

  test('no rejected node (not yet landed) → missing (transient, client retries)', () => {
    expect(resolveAbsentOriginalStatus(null, DRIVER)).toEqual({ terminal: 'missing' });
    expect(resolveAbsentOriginalStatus(undefined, DRIVER)).toEqual({ terminal: 'missing' });
  });

  test('rejected original owned by ANOTHER driver → missing (no cross-driver probe/leak)', () => {
    const r = resolveAbsentOriginalStatus(rejectedNode({ packet: { driverId: 'someone-else' } }), DRIVER);
    expect(r).toEqual({ terminal: 'missing' });
  });

  test('rejected node without a packet block → missing (cannot verify ownership)', () => {
    const r = resolveAbsentOriginalStatus({ reason: 'STALE_PULL_TIME' }, DRIVER);
    expect(r).toEqual({ terminal: 'missing' });
  });

  test('falls back to readableReason, then a generic reason', () => {
    const r1 = resolveAbsentOriginalStatus(rejectedNode({ reason: undefined, readableReason: 'time is stale' }), DRIVER);
    expect(r1.terminal === 'rejected' && r1.reason).toBe('original_rejected: time is stale');
    const r2 = resolveAbsentOriginalStatus(rejectedNode({ reason: undefined, readableReason: undefined }), DRIVER);
    expect(r2.terminal === 'rejected' && r2.reason).toBe('original_rejected: original_rejected');
  });

  test('array / primitive nodes are treated as absent → missing', () => {
    expect(resolveAbsentOriginalStatus([rejectedNode()], DRIVER)).toEqual({ terminal: 'missing' });
    expect(resolveAbsentOriginalStatus('rejected', DRIVER)).toEqual({ terminal: 'missing' });
  });
});
