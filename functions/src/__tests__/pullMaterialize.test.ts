import { applyCurrentStateIfOwner, namespacedWellStatePath } from '../packetGuards';
import { runOwnerMaterializeTxn, type TxnRef } from '../pullMaterialize';

const CURRENT = { level: "6'6\"", levelInches: 78 };

/**
 * Fake RTDB Reference that faithfully reproduces the Admin SDK transaction
 * contract that caused the P0:
 *  - `optimisticNullFirst`: the update fn is first called with `null` (no local
 *    cache). If it returns `undefined` the transaction ABORTS immediately (this
 *    is exactly what killed the old abort-on-null code). If it returns a value,
 *    the optimistic write conflicts with a non-null server value, so the SDK
 *    re-runs the update fn with the real server value.
 */
function fakeRef(serverValue: unknown, opts: { optimisticNullFirst?: boolean } = {}): TxnRef & { read(): unknown } {
  let value = serverValue;
  const optimistic = opts.optimisticNullFirst !== false;
  return {
    read: () => value,
    async transaction(update) {
      if (optimistic) {
        const r1 = update(null);
        if (r1 === undefined) {
          return { committed: false, snapshot: { val: () => value } }; // aborted on null
        }
        if (value === null || value === undefined) {
          value = r1; // server genuinely empty → optimistic write commits
          return { committed: true, snapshot: { val: () => value } };
        }
        // server has data → SDK re-runs with the authoritative server value
      }
      const r2 = update(value);
      if (r2 === undefined) {
        return { committed: false, snapshot: { val: () => value } }; // real abort
      }
      value = r2;
      return { committed: true, snapshot: { val: () => value } };
    },
  };
}

const ownerNode = (packetId: string, extra: Record<string, unknown> = {}) => ({
  companyId: 'liquid-gold',
  wellKey: 'Gabriel 1',
  pullHighWater: { dateTimeUTC: '2026-09-06T20:13:03.169Z', packetId, companyId: 'liquid-gold', wellKey: 'Gabriel 1' },
  ...extra,
});

describe('applyCurrentStateIfOwner (pure decision)', () => {
  it('returns RETRY on the optimistic null-first read (never aborts before the server value)', () => {
    expect(applyCurrentStateIfOwner({ node: null, packetId: 'P1', current: CURRENT })).toEqual({ action: 'retry' });
    expect(applyCurrentStateIfOwner({ node: undefined, packetId: 'P1', current: CURRENT })).toEqual({ action: 'retry' });
  });

  it('ABORTS (fail closed) when the server node has no owner', () => {
    expect(applyCurrentStateIfOwner({ node: {}, packetId: 'P1', current: CURRENT })).toEqual({ action: 'abort' });
    expect(applyCurrentStateIfOwner({ node: { pullHighWater: null }, packetId: 'P1', current: CURRENT })).toEqual({ action: 'abort' });
  });

  it('ABORTS when a different packet owns the high-water (superseded — never weakened)', () => {
    expect(applyCurrentStateIfOwner({ node: ownerNode('OTHER'), packetId: 'P1', current: CURRENT })).toEqual({ action: 'abort' });
  });

  it('COMMITS current-state when this packet owns the high-water, preserving pullHighWater', () => {
    const d = applyCurrentStateIfOwner({ node: ownerNode('P1'), packetId: 'P1', current: CURRENT });
    expect(d.action).toBe('commit');
    if (d.action !== 'commit') return;
    expect(d.already).toBe(false);
    expect(d.next.materializedPacketId).toBe('P1');
    expect(d.next.current).toEqual(CURRENT);
    expect((d.next.pullHighWater as { packetId: string }).packetId).toBe('P1'); // high-water untouched
  });

  it('flags an idempotent re-materialization (already materialized by this packet)', () => {
    const d = applyCurrentStateIfOwner({ node: ownerNode('P1', { materializedPacketId: 'P1' }), packetId: 'P1', current: CURRENT });
    expect(d.action === 'commit' && d.already).toBe(true);
  });
});

describe('runOwnerMaterializeTxn (transaction runner — the P0 fix)', () => {
  it('P0 REGRESSION GUARD: optimistic null-first THEN matching server owner still materializes', async () => {
    const ref = fakeRef(ownerNode('P1'), { optimisticNullFirst: true });
    const events: string[] = [];
    const res = await runOwnerMaterializeTxn({ ref, packetId: 'P1', current: CURRENT, onEvent: (e) => events.push(e) });
    expect(res.materialized).toBe(true);
    expect(res.outcome).toBe('materialized');
    expect(events).toContain('retry'); // proves it went through the null-first retry path
    expect((ref.read() as { materializedPacketId?: string }).materializedPacketId).toBe('P1');
    expect((ref.read() as { pullHighWater: { packetId: string } }).pullHighWater.packetId).toBe('P1');
  });

  it('matching owner materializes exactly once (no optimistic null)', async () => {
    const ref = fakeRef(ownerNode('P1'), { optimisticNullFirst: false });
    const res = await runOwnerMaterializeTxn({ ref, packetId: 'P1', current: CURRENT });
    expect(res).toEqual({ materialized: true, outcome: 'materialized' });
  });

  it('true server-side missing owner: no materialization (fail closed)', async () => {
    const ref = fakeRef(null, { optimisticNullFirst: true });
    const res = await runOwnerMaterializeTxn({ ref, packetId: 'P1', current: CURRENT });
    expect(res.materialized).toBe(false);
    expect(res.outcome).toBe('no_owner');
    expect((ref.read() as { materializedPacketId?: string })?.materializedPacketId).toBeUndefined();
  });

  it('packet A claims then B supersedes: A cannot materialize, B can', async () => {
    // High-water now owned by B.
    const refA = fakeRef(ownerNode('B'), { optimisticNullFirst: true });
    const a = await runOwnerMaterializeTxn({ ref: refA, packetId: 'A', current: CURRENT });
    expect(a).toEqual({ materialized: false, outcome: 'superseded' });
    expect((refA.read() as { materializedPacketId?: string }).materializedPacketId).toBeUndefined();

    const refB = fakeRef(ownerNode('B'), { optimisticNullFirst: true });
    const b = await runOwnerMaterializeTxn({ ref: refB, packetId: 'B', current: CURRENT });
    expect(b.materialized).toBe(true);
  });

  it('duplicate invocation is idempotent (already-materialized owner)', async () => {
    const ref = fakeRef(ownerNode('P1', { materializedPacketId: 'P1', current: CURRENT }), { optimisticNullFirst: true });
    const res = await runOwnerMaterializeTxn({ ref, packetId: 'P1', current: CURRENT });
    expect(res).toEqual({ materialized: true, outcome: 'already' });
  });

  it('tenant/well namespaces cannot collide (isolated nodes and paths)', async () => {
    expect(namespacedWellStatePath('liquid-gold', 'Gabriel 1'))
      .not.toBe(namespacedWellStatePath('liquid-gold', 'Gabriel 7'));
    expect(namespacedWellStatePath('acme', 'Gabriel 1'))
      .not.toBe(namespacedWellStatePath('liquid-gold', 'Gabriel 1'));
    // A materialize against well-1's node never touches well-7's node.
    const ref1 = fakeRef(ownerNode('P1'), { optimisticNullFirst: true });
    const ref7 = fakeRef(ownerNode('P7'), { optimisticNullFirst: true });
    await runOwnerMaterializeTxn({ ref: ref1, packetId: 'P1', current: CURRENT });
    expect((ref7.read() as { materializedPacketId?: string }).materializedPacketId).toBeUndefined();
  });

  it('a newer canonical owner is never regressed: an older packet abort leaves high-water intact', async () => {
    const ref = fakeRef(ownerNode('NEWER'), { optimisticNullFirst: true });
    await runOwnerMaterializeTxn({ ref: ref, packetId: 'OLDER', current: CURRENT });
    // high-water still points at NEWER; nothing materialized.
    expect((ref.read() as { pullHighWater: { packetId: string } }).pullHighWater.packetId).toBe('NEWER');
    expect((ref.read() as { materializedPacketId?: string }).materializedPacketId).toBeUndefined();
  });
});
