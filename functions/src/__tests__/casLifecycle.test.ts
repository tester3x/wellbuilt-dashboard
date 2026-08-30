// Completion-audit item 6: the CAS listener fix must not leak listeners,
// double-fire, hang, or mistake stale local state for authority. Contention
// and full-process lifecycle run on the real emulator (faults.mjs — many
// mutations, contended workers, clean exits); these tests pin the adapter's
// attach/detach discipline on every exit path.
import { makeCoordinatorIO, type DbLike, type RefLike } from '../coordinatorIO';
import type { LockRecord } from '../chronoCommitCoordinator';

interface FakeState { value: unknown }

function makeFakeRef(state: FakeState, opts: { withListeners?: boolean; throwOnTransaction?: boolean } = {}) {
  const listeners: Array<(s: unknown) => void> = [];
  let onCalls = 0;
  let offCalls = 0;
  let onceCalls = 0;
  const ref: RefLike = {
    async once() { onceCalls++; return { val: () => state.value }; },
    async transaction(update) {
      if (opts.throwOnTransaction) throw new Error('transaction transport failure');
      const next = update(state.value);
      if (next === undefined) return { committed: false, snapshot: { val: () => state.value } };
      state.value = next;
      return { committed: true, snapshot: { val: () => state.value } };
    },
    async update() { return undefined; },
    ...(opts.withListeners === false ? {} : {
      on: (_evt: 'value', cb: (s: unknown) => void) => { onCalls++; listeners.push(cb); return cb; },
      off: (_evt: 'value', cb: (s: unknown) => void) => {
        offCalls++;
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    }),
  };
  return { ref, counters: () => ({ onCalls, offCalls, onceCalls, active: listeners.length }) };
}

function makeDb(refsByPath: Map<string, RefLike>): DbLike {
  return { ref: (path?: string) => refsByPath.get(path ?? '') ?? refsByPath.values().next().value! };
}

const LOCK_PATH = 'wells/W/status/chronoLock';

describe('casLock listener lifecycle — attach/detach on EVERY exit path', () => {
  test('success: listener attached for the CAS, detached after, none left active', async () => {
    const state: FakeState = { value: null };
    const fake = makeFakeRef(state);
    const io = makeCoordinatorIO(makeDb(new Map([[LOCK_PATH, fake.ref]])), 'W');
    const res = await io.casLock('W', () => ({ token: 't', fence: 1, phase: 'planning', at: 1, operationId: 'op' } as LockRecord));
    expect(res.ok).toBe(true);
    const c = fake.counters();
    expect(c.onCalls).toBe(1);
    expect(c.offCalls).toBe(1);
    expect(c.active).toBe(0);         // no leak
    expect(c.onceCalls).toBe(1);      // cache primed exactly once
  });

  test('CAS rejection (abort): still detaches; ok:false; state untouched', async () => {
    const state: FakeState = { value: { token: 'other', fence: 3, phase: 'committing', at: 1, operationId: 'x' } };
    const fake = makeFakeRef(state);
    const io = makeCoordinatorIO(makeDb(new Map([[LOCK_PATH, fake.ref]])), 'W');
    const res = await io.casLock('W', () => undefined); // abort
    expect(res.ok).toBe(false);
    expect(fake.counters().active).toBe(0);
    expect((state.value as LockRecord).fence).toBe(3);
  });

  test('transaction exception: listener detached in finally, error propagates', async () => {
    const state: FakeState = { value: null };
    const fake = makeFakeRef(state, { throwOnTransaction: true });
    const io = makeCoordinatorIO(makeDb(new Map([[LOCK_PATH, fake.ref]])), 'W');
    await expect(io.casLock('W', () => null)).rejects.toThrow('transaction transport failure');
    const c = fake.counters();
    expect(c.offCalls).toBe(1);
    expect(c.active).toBe(0);
  });

  test('unit-test fakes without on/off keep working (no listener requirement)', async () => {
    const state: FakeState = { value: null };
    const fake = makeFakeRef(state, { withListeners: false });
    const io = makeCoordinatorIO(makeDb(new Map([[LOCK_PATH, fake.ref]])), 'W');
    const res = await io.casLock('W', () => null);
    expect(res.ok).toBe(true);
  });

  test('repeated mutations leave NO growing active-listener count', async () => {
    const state: FakeState = { value: null };
    const fake = makeFakeRef(state);
    const io = makeCoordinatorIO(makeDb(new Map([[LOCK_PATH, fake.ref]])), 'W');
    for (let i = 0; i < 25; i++) {
      await io.casLock('W', (cur) => (cur ? null : { token: `t${i}`, fence: i, phase: 'planning', at: i, operationId: 'op' } as LockRecord));
    }
    const c = fake.counters();
    expect(c.onCalls).toBe(25);
    expect(c.offCalls).toBe(25);
    expect(c.active).toBe(0);
  });

  test('two contenders: the second sees the FIRST holder through the transaction value (never a stale null)', async () => {
    const state: FakeState = { value: null };
    const fake = makeFakeRef(state);
    const io = makeCoordinatorIO(makeDb(new Map([[LOCK_PATH, fake.ref]])), 'W');
    const holder: LockRecord = { token: 'A', fence: 1, phase: 'planning', at: 1, operationId: 'opA' };
    await io.casLock('W', () => holder);
    let sawHolder: unknown = 'unset';
    const res = await io.casLock('W', (cur) => { sawHolder = cur; return undefined; }); // B aborts on live holder
    expect(res.ok).toBe(false);
    expect(sawHolder).toEqual(holder); // authoritative value, not local null
    expect(fake.counters().active).toBe(0);
  });

  test('stale owner cannot release a newer lock (planReleaseCommitting semantics through the adapter)', async () => {
    const newer: LockRecord = { token: 'B', fence: 5, phase: 'committing', at: 9, operationId: 'opB' };
    const state: FakeState = { value: newer };
    const fake = makeFakeRef(state);
    const io = makeCoordinatorIO(makeDb(new Map([[LOCK_PATH, fake.ref]])), 'W');
    // Simulate the release CAS a stale owner (token A, fence 4) would issue.
    const res = await io.casLock('W', (cur) => {
      const c = cur as LockRecord | null;
      return c && c.token === 'A' && c.fence === 4 ? null : c; // leave newer intact
    });
    expect(res.ok).toBe(true);
    expect(state.value).toEqual(newer); // untouched
    expect(fake.counters().active).toBe(0);
  });
});
