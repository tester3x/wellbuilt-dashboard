// Serialized atomic coordinator — crash/recovery atomicity matrix (controlled
// clock, injected store). Proves final canonical state is entirely-old or
// entirely-new at every interruption point.
import {
  runCanonicalMutation, planLockAcquire, planTransitionToCommitting,
  commitHorizonMs, DEFAULT_TIMEOUTS,
  type CoordinatorIO, type LockRecord, type CommitReceipt, type MutationRequest,
} from '../chronoCommitCoordinator';

const WELL = 'Atlas1';
const T = DEFAULT_TIMEOUTS;
const HORIZON = commitHorizonMs(T); // 120_000

function makeServer(startClock = 1000) {
  const state = {
    lock: null as LockRecord | null,
    canonical: {} as Record<string, unknown>, // includes RECEIPT:<opId> entries
    clock: startClock,
    tokenSeq: 0,
    commitFailNext: false,
    skipReleaseNext: false,
  };
  const io: CoordinatorIO = {
    now: () => state.clock,
    newToken: () => `tok${++state.tokenSeq}`,
    readLock: async () => state.lock,
    casLock: async (_w, apply) => {
      const next = apply(state.lock);
      if (next === undefined) return { ok: false };
      state.lock = next;
      return { ok: true, value: next };
    },
    readReceipt: async (_w, opId) => (state.canonical[`RECEIPT:${opId}`] as CommitReceipt) ?? null,
    commitAtomic: async (patch) => {
      if (state.commitFailNext) { state.commitFailNext = false; throw new Error('rtdb update failed'); }
      Object.assign(state.canonical, patch); // atomic all-or-nothing
    },
  };
  return { state, io };
}

const reqFor = (opId: string, marker = 'NEW'): MutationRequest => ({
  wellName: WELL,
  operationId: opId,
  buildPatch: async ({ fence }) => {
    const receipt: CommitReceipt = {
      operationId: opId, mutationType: 'backdated_create', wellName: WELL, fence, revision: fence,
      affectedPacketIds: ['p1', 'p2'], committedAtMs: 0, patchHash: `hash-${marker}`,
    };
    return {
      patch: {
        'packets/processed/p1/recoveryInches': marker === 'NEW' ? 110 : 92,
        'packets/outgoing/current': marker,
        [`RECEIPT:${opId}`]: receipt, // receipt is PART of the atomic patch
      },
      receipt,
    };
  },
});

describe('happy path + idempotency', () => {
  test('one worker commits atomically; receipt written; lock released', async () => {
    const { state, io } = makeServer();
    const out = await runCanonicalMutation(io, reqFor('op1'));
    expect(out.status).toBe('committed');
    expect(state.canonical['packets/outgoing/current']).toBe('NEW');
    expect(state.canonical['RECEIPT:op1']).toBeTruthy();
    expect(state.lock).toBeNull(); // released
  });

  test('re-run with an existing receipt → already_done, no re-commit', async () => {
    const { state, io } = makeServer();
    await runCanonicalMutation(io, reqFor('op1'));
    const before = { ...state.canonical };
    const out = await runCanonicalMutation(io, reqFor('op1', 'DIFFERENT'));
    expect(out.status).toBe('already_done');
    expect(state.canonical).toEqual(before); // untouched
  });
});

describe('atomicity: final state is entirely-old or entirely-new', () => {
  test('crash after entering committing but BEFORE the update → nothing applied; recovery requeues same op', async () => {
    const { state, io } = makeServer();
    state.commitFailNext = true; // the atomic update throws
    const out = await runCanonicalMutation(io, reqFor('op2'));
    expect(out.status).toBe('commit_failed');
    // ENTIRELY OLD: no canonical change, no receipt.
    expect(state.canonical['packets/outgoing/current']).toBeUndefined();
    expect(state.canonical['RECEIPT:op2']).toBeUndefined();
    // lock is stuck committing.
    expect(state.lock?.phase).toBe('committing');

    // Retry within max lifetime → contended, NO takeover.
    state.clock += T.functionMaxMs - 1;
    const early = await runCanonicalMutation(io, reqFor('op2'));
    expect(early.status).toBe('contended');

    // Retry AFTER the horizon → recover: receipt absent → requeue same op id.
    state.clock += HORIZON;
    const rec = await runCanonicalMutation(io, reqFor('op2'));
    expect(rec).toMatchObject({ status: 'recovered_requeue', operationId: 'op2' });
    expect(state.lock).toBeNull(); // cleared

    // The requeued same-op retry now commits cleanly (idempotent by op id).
    const done = await runCanonicalMutation(io, reqFor('op2'));
    expect(done.status).toBe('committed');
    expect(state.canonical['RECEIPT:op2']).toBeTruthy();
  });

  test('crash AFTER the atomic update but before release → a LATER worker sees the receipt → releases, NO double commit', async () => {
    const { state, io } = makeServer();
    // op3 committed atomically (receipt present) but the worker died before
    // releasing → the lock is stuck committing under op3's dead token.
    await runCanonicalMutation(io, reqFor('op3'));
    state.lock = { token: 'deadTok', fence: 9, phase: 'committing', at: state.clock, operationId: 'op3' };
    const beforeCanonical = { ...state.canonical };

    // A DIFFERENT operation (op4) arrives after the horizon and performs recovery.
    state.clock += HORIZON + 1;
    const out = await runCanonicalMutation(io, reqFor('op4'));
    expect(out.status).toBe('recovered_released'); // saw op3's receipt → released
    expect(state.lock).toBeNull();
    // No double commit — recovery did not touch canonical state.
    expect(state.canonical).toEqual(beforeCanonical);
  });

  test('crash during PLANNING → lease expiry lets another worker acquire normally', async () => {
    const { state, io } = makeServer();
    // A holds a planning lock and vanishes.
    state.lock = { token: 'A', fence: 1, phase: 'planning', at: state.clock, operationId: 'opA' };
    // Within the planning lease → contended.
    const d1 = planLockAcquire(state.lock, 'B', state.clock + T.planningLeaseMs - 1, T, 'opB');
    expect(d1.kind).toBe('contended');
    // After the lease → B acquires (fence bumps).
    const d2 = planLockAcquire(state.lock, 'B', state.clock + T.planningLeaseMs + 1, T, 'opB');
    expect(d2.kind).toBe('acquire');
    if (d2.kind === 'acquire') expect(d2.next.fence).toBe(2);
  });
});

describe('stale worker cannot commit after ownership changes', () => {
  test('A (planning fence 1) pauses, B takes over + commits, A resumes → transition refused (lost_ownership)', () => {
    // A acquired planning fence 1.
    let lock: LockRecord | null = { token: 'A', fence: 1, phase: 'planning', at: 1000, operationId: 'opA' };
    // B takes over after the lease (fence 2) and eventually the lock reflects B/other.
    lock = { token: 'B', fence: 2, phase: 'committing', at: 40_000, operationId: 'opB' };
    // A resumes and tries to enter committing with its OLD token+fence.
    const t = planTransitionToCommitting(lock, 'A', 1, 90_000);
    expect(t).toBeUndefined(); // A cannot commit — ownership changed
    // The rightful owner B can.
    expect(planTransitionToCommitting({ token: 'B', fence: 2, phase: 'planning', at: 1, operationId: 'opB' }, 'B', 2, 2)).toBeTruthy();
  });
});

describe('horizon is tied to the real function lifetime', () => {
  test('committing lock recoverable only after functionMaxMs + margin', () => {
    const lock: LockRecord = { token: 'x', fence: 1, phase: 'committing', at: 0, operationId: 'op' };
    expect(planLockAcquire(lock, 'y', HORIZON - 1, T, 'op2').kind).toBe('contended');   // within horizon
    expect(planLockAcquire(lock, 'y', HORIZON + 1, T, 'op2').kind).toBe('recover');      // past horizon
    expect(HORIZON).toBe(60_000 + 60_000); // 60s v1 max + 60s margin
  });
});
