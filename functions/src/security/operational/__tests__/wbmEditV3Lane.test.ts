import {
  decideSubmit,
  decideClaim,
  decideApplyOutcome,
  decideReconcile,
  rejectExhausted,
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
