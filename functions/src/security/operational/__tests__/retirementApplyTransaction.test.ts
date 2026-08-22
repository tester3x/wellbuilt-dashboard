/**
 * Primed aborting stamp for approved-row retirement.
 *
 * Missing current must not become { legacyLoginRetired: true }.
 */
import { commitApprovedRetirementStamp, type ApprovedRowRef } from '../retirementApplyTransaction';

const ALPHA_NAME = 'FixtureDriverAlpha';

function alphaRow(): Record<string, unknown> {
  return {
    active: true,
    displayName: ALPHA_NAME,
    companyId: 'fixture-co',
    truckNumber: 'T-100',
  };
}

type FakeSnap = { exists(): boolean; val(): unknown };

type FakeRefOpts = {
  cancelWith?: Error;
  throwOnAttach?: Error;
  rejectTransaction?: Error;
};

function makeFakeRef(
  initial: Record<string, unknown> | null,
  opts: FakeRefOpts = {},
): ApprovedRowRef & {
  store: { value: Record<string, unknown> | null };
  writes: number;
  listenerCount(): number;
} {
  const store = { value: initial ? { ...initial } : null };
  const listeners = new Set<(...args: unknown[]) => void>();
  const ref = {
    store,
    writes: 0,
    listenerCount: () => listeners.size,
    on(
      _event: 'value',
      callback: (...args: unknown[]) => void,
      cancel?: (err: Error) => void,
    ) {
      if (opts.throwOnAttach) throw opts.throwOnAttach;
      listeners.add(callback);
      if (opts.cancelWith) {
        cancel?.(opts.cancelWith);
        return callback;
      }
      callback();
      return callback;
    },
    off(_event: 'value', callback?: (...args: unknown[]) => void) {
      if (callback) listeners.delete(callback);
      else listeners.clear();
    },
    async once(_event: 'value'): Promise<FakeSnap> {
      return {
        exists: () => store.value != null,
        val: () => store.value,
      };
    },
    async transaction(update: (current: unknown) => unknown): Promise<{
      committed: boolean;
      snapshot: FakeSnap;
    }> {
      if (opts.rejectTransaction) throw opts.rejectTransaction;
      const current = listeners.size > 0 ? store.value : null;
      const next = update(current);
      if (next === undefined) {
        return {
          committed: false,
          snapshot: { exists: () => false, val: () => null },
        };
      }
      store.value = next as Record<string, unknown>;
      ref.writes += 1;
      return {
        committed: true,
        snapshot: {
          exists: () => store.value != null,
          val: () => store.value,
        },
      };
    },
  };
  return ref;
}

describe('commitApprovedRetirementStamp', () => {
  it('normal existing-row retirement succeeds, preserves fields, and rereads the flag', async () => {
    const ref = makeFakeRef(alphaRow());
    const result = await commitApprovedRetirementStamp({ approvedRef: ref });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written.legacyLoginRetired).toBe(true);
    expect(result.written.displayName).toBe(ALPHA_NAME);
    expect(result.written.companyId).toBe('fixture-co');
    expect(result.written.truckNumber).toBe('T-100');
    expect(ref.store.value?.legacyLoginRetired).toBe(true);
    expect(ref.writes).toBe(1);
    expect(ref.listenerCount()).toBe(0);
  });

  it('row missing at stamp writes no ghost row', async () => {
    const ref = makeFakeRef(null);
    const result = await commitApprovedRetirementStamp({ approvedRef: ref });
    expect(result).toEqual({ ok: false, reason: 'approved_row_missing' });
    expect(ref.writes).toBe(0);
    expect(ref.store.value).toBeNull();
    expect(ref.listenerCount()).toBe(0);
  });

  it('row deleted between binding repair and stamp aborts without creating a ghost', async () => {
    const ref = makeFakeRef(alphaRow());
    ref.store.value = null;
    const result = await commitApprovedRetirementStamp({ approvedRef: ref });
    expect(result).toEqual({ ok: false, reason: 'approved_row_missing' });
    expect(ref.writes).toBe(0);
    expect(ref.store.value).toBeNull();
  });

  it('malformed row aborts and does not replace the node', async () => {
    const ref = makeFakeRef({ active: true });
    const result = await commitApprovedRetirementStamp({ approvedRef: ref });
    expect(result).toEqual({ ok: false, reason: 'approved_row_malformed' });
    expect(ref.writes).toBe(0);
    expect(ref.store.value).toEqual({ active: true });
  });

  it('naive update() of a missing path would ghost; the stamp does not', async () => {
    const ghostStore: { value: Record<string, unknown> | null } = { value: null };
    const naiveUpdate = (patch: Record<string, unknown>) => {
      ghostStore.value = { ...(ghostStore.value || {}), ...patch };
    };
    naiveUpdate({ legacyLoginRetired: true });
    expect(ghostStore.value).toEqual({ legacyLoginRetired: true });

    const ref = makeFakeRef(null);
    const result = await commitApprovedRetirementStamp({ approvedRef: ref });
    expect(result.ok).toBe(false);
    expect(ref.store.value).toBeNull();
    expect(ref.store.value).not.toEqual({ legacyLoginRetired: true });
  });
});
