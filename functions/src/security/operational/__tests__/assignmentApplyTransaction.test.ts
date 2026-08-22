import {
  previewContextDigest,
  revisionNumber,
} from '../assignmentScope';
import {
  commitCanonicalAssignmentWrite,
  type AssignmentProfileRef,
} from '../assignmentApplyTransaction';

const DRIVER_A = '00000000-0000-4000-8000-00000000000a';
const DRIVER_B = '00000000-0000-4000-8000-00000000000b';
const COMPANY = 'test-co';
const ROUTES = ['Route One', 'Route Two'];
const WELLS: string[] = [];
const ACTOR = 'actor-uid';
const NOW = 1_700_000_000_000;

type FakeSnap = { exists(): boolean; val(): unknown };

type FakeRefOpts = {
  cancelWith?: Error;
  throwOnAttach?: Error;
  rejectTransaction?: Error;
};

function makeFakeRef(
  initial: Record<string, unknown> | null,
  opts: FakeRefOpts = {},
): AssignmentProfileRef & {
  store: { value: Record<string, unknown> | null };
  writes: number;
  listenerCount(): number;
  hasListener(cb: (...args: unknown[]) => void): boolean;
} {
  const store = { value: initial ? { ...initial } : null };
  const listeners = new Set<(...args: unknown[]) => void>();
  const ref = {
    store,
    writes: 0,
    listenerCount: () => listeners.size,
    hasListener: (cb: (...args: unknown[]) => void) => listeners.has(cb),
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
    async transaction(update: (current: unknown) => unknown): Promise<{
      committed: boolean;
      snapshot: FakeSnap;
    }> {
      if (opts.rejectTransaction) throw opts.rejectTransaction;
      // Admin SDK: no complete listener cache → false null, abort on undefined.
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

function baseProfile(over: Record<string, unknown> = {}) {
  return {
    active: true,
    companyId: COMPANY,
    displayName: 'fixture-a',
    ...over,
  };
}

function digestFor(
  driverId: string,
  profile: Record<string, unknown>,
  proposedRoutes: string[],
  proposedWells: string[],
) {
  return previewContextDigest({
    driverId,
    companyId: String(profile.companyId),
    assignmentRevision: revisionNumber(profile.assignmentRevision),
    currentRoutes: profile.assignedRoutes ?? null,
    currentWells: profile.assignedWells ?? null,
    proposedRoutes,
    proposedWells,
  });
}

type FakeRef = ReturnType<typeof makeFakeRef>;

function applyArgs(ref: FakeRef, over: Record<string, unknown> = {}) {
  const profile = ref.store.value || {};
  return {
    profileRef: ref,
    driverId: DRIVER_A,
    expectedPreviewContextDigest: digestFor(DRIVER_A, profile, ROUTES, WELLS),
    proposedRoutes: ROUTES,
    proposedWells: WELLS,
    callerCompanyId: COMPANY,
    isPlatformAdmin: true,
    callerUid: ACTOR,
    nowMs: NOW,
    ...over,
  };
}

describe('commitCanonicalAssignmentWrite cache and isolation', () => {
  it('aborts as profile_missing when the transaction sees a false-null cache', async () => {
    const live = baseProfile();
    const ref = makeFakeRef(live);
    const digest = digestFor(DRIVER_A, live, ROUTES, WELLS);
    const tx = await ref.transaction((current) => {
      if (!current) return;
      return { ...(current as object), assignedRoutes: ROUTES };
    });
    expect(tx.committed).toBe(false);
    expect(ref.writes).toBe(0);
    expect(ref.store.value).toEqual(live);

    const applied = await commitCanonicalAssignmentWrite({
      profileRef: ref,
      driverId: DRIVER_A,
      expectedPreviewContextDigest: digest,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    });
    expect(applied).toEqual(expect.objectContaining({ ok: true, assignmentRevision: 1 }));
    expect(ref.writes).toBe(1);
  });

  it('Preview then unchanged Apply succeeds exactly once and increments revision once', async () => {
    const live = baseProfile();
    const ref = makeFakeRef(live);
    const previewDigest = digestFor(DRIVER_A, live, ROUTES, WELLS);
    const first = await commitCanonicalAssignmentWrite({
      ...applyArgs(ref),
      expectedPreviewContextDigest: previewDigest,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.assignmentRevision).toBe(1);
    expect(ref.writes).toBe(1);
    expect(ref.store.value?.assignmentRevision).toBe(1);
    expect(ref.store.value?.assignedRoutes).toEqual(ROUTES);
    expect(ref.store.value?.assignedWells).toEqual(WELLS);
    expect(ref.listenerCount()).toBe(0);

    const replay = await commitCanonicalAssignmentWrite({
      ...applyArgs(ref),
      expectedPreviewContextDigest: previewDigest,
    });
    expect(replay).toEqual({ ok: false, reason: 'stale_preview_context' });
    expect(ref.writes).toBe(1);
    expect(ref.store.value?.assignmentRevision).toBe(1);
  });

  it('a genuinely changed profile still returns stale_preview_context', async () => {
    const live = baseProfile();
    const ref = makeFakeRef(live);
    const previewDigest = digestFor(DRIVER_A, live, ROUTES, WELLS);
    ref.store.value = { ...live, assignedRoutes: ['Other Route'] };
    const applied = await commitCanonicalAssignmentWrite({
      ...applyArgs(ref),
      expectedPreviewContextDigest: previewDigest,
    });
    expect(applied).toEqual({ ok: false, reason: 'stale_preview_context' });
    expect(ref.writes).toBe(0);
  });

  it('wrong digest, UUID, company, revision, routes, or wells fails closed', async () => {
    const live = baseProfile();
    const ref = makeFakeRef(live);
    const good = digestFor(DRIVER_A, live, ROUTES, WELLS);

    const wrongDigest = await commitCanonicalAssignmentWrite({
      ...applyArgs(ref),
      expectedPreviewContextDigest: good + 'x',
    });
    expect(wrongDigest).toEqual({ ok: false, reason: 'stale_preview_context' });

    const wrongUuid = await commitCanonicalAssignmentWrite({
      ...applyArgs(ref),
      driverId: DRIVER_B,
      expectedPreviewContextDigest: good,
    });
    expect(wrongUuid).toEqual({ ok: false, reason: 'stale_preview_context' });

    const otherCo = makeFakeRef({ ...live, companyId: 'other-co' });
    const wrongCompany = await commitCanonicalAssignmentWrite({
      ...applyArgs(otherCo),
      expectedPreviewContextDigest: good,
    });
    expect(wrongCompany).toEqual({ ok: false, reason: 'stale_preview_context' });

    const revProfile = makeFakeRef({ ...live, assignmentRevision: 4 });
    const wrongRev = await commitCanonicalAssignmentWrite({
      ...applyArgs(revProfile),
      expectedPreviewContextDigest: good,
    });
    expect(wrongRev).toEqual({ ok: false, reason: 'stale_preview_context' });

    const wrongRoutes = await commitCanonicalAssignmentWrite({
      ...applyArgs(ref),
      expectedPreviewContextDigest: good,
      proposedRoutes: ['Route One'],
    });
    expect(wrongRoutes).toEqual({ ok: false, reason: 'stale_preview_context' });

    const wrongWells = await commitCanonicalAssignmentWrite({
      ...applyArgs(ref),
      expectedPreviewContextDigest: good,
      proposedWells: ['Well X'],
    });
    expect(wrongWells).toEqual({ ok: false, reason: 'stale_preview_context' });
    expect(ref.writes).toBe(0);
    expect(otherCo.writes).toBe(0);
    expect(revProfile.writes).toBe(0);
  });

  it('two drivers cannot share preview state', async () => {
    const profileA = baseProfile();
    const profileB = baseProfile({ displayName: 'fixture-b' });
    const refA = makeFakeRef(profileA);
    const refB = makeFakeRef(profileB);
    const digestA = digestFor(DRIVER_A, profileA, ROUTES, WELLS);
    const stolen = await commitCanonicalAssignmentWrite({
      profileRef: refB,
      driverId: DRIVER_B,
      expectedPreviewContextDigest: digestA,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    });
    expect(stolen).toEqual({ ok: false, reason: 'stale_preview_context' });
    expect(refB.writes).toBe(0);

    const own = await commitCanonicalAssignmentWrite({
      profileRef: refA,
      driverId: DRIVER_A,
      expectedPreviewContextDigest: digestA,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    });
    expect(own.ok).toBe(true);
    expect(refA.writes).toBe(1);
    expect(refB.store.value?.assignmentRevision).toBeUndefined();
  });

  it('a warm instance cannot reuse another request’s cached listener or digest', async () => {
    const refA = makeFakeRef(baseProfile());
    const refB = makeFakeRef(baseProfile({ displayName: 'fixture-b' }));
    const digestA = digestFor(DRIVER_A, refA.store.value as Record<string, unknown>, ROUTES, WELLS);
    const digestB = digestFor(DRIVER_B, refB.store.value as Record<string, unknown>, ROUTES, WELLS);

    const a = await commitCanonicalAssignmentWrite({
      profileRef: refA,
      driverId: DRIVER_A,
      expectedPreviewContextDigest: digestA,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    });
    expect(a.ok).toBe(true);
    expect(refA.listenerCount()).toBe(0);

    const reusedDigest = await commitCanonicalAssignmentWrite({
      profileRef: refB,
      driverId: DRIVER_B,
      expectedPreviewContextDigest: digestA,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    });
    expect(reusedDigest).toEqual({ ok: false, reason: 'stale_preview_context' });
    expect(refB.writes).toBe(0);

    const b = await commitCanonicalAssignmentWrite({
      profileRef: refB,
      driverId: DRIVER_B,
      expectedPreviewContextDigest: digestB,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    });
    expect(b.ok).toBe(true);
    expect(refB.writes).toBe(1);
    expect(refA.store.value?.assignmentRevision).toBe(1);
    expect(refB.store.value?.assignmentRevision).toBe(1);
  });

  it('prime cancellation fails closed and removes the exact listener', async () => {
    const live = baseProfile();
    const ref = makeFakeRef(live, { cancelWith: new Error('listener_cancelled') });
    const digest = digestFor(DRIVER_A, live, ROUTES, WELLS);
    await expect(commitCanonicalAssignmentWrite({
      profileRef: ref,
      driverId: DRIVER_A,
      expectedPreviewContextDigest: digest,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    })).rejects.toThrow('listener_cancelled');
    expect(ref.listenerCount()).toBe(0);
    expect(ref.writes).toBe(0);
    expect(ref.store.value).toEqual(live);
  });

  it('synchronous on() error fails closed and still removes the exact listener', async () => {
    const live = baseProfile();
    const ref = makeFakeRef(live, { throwOnAttach: new Error('on_failed') });
    const digest = digestFor(DRIVER_A, live, ROUTES, WELLS);
    await expect(commitCanonicalAssignmentWrite({
      profileRef: ref,
      driverId: DRIVER_A,
      expectedPreviewContextDigest: digest,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    })).rejects.toThrow('on_failed');
    expect(ref.listenerCount()).toBe(0);
    expect(ref.writes).toBe(0);
    expect(ref.store.value).toEqual(live);
  });

  it('transaction rejection removes the exact listener and writes nothing', async () => {
    const live = baseProfile();
    const ref = makeFakeRef(live, { rejectTransaction: new Error('tx_failed') });
    const digest = digestFor(DRIVER_A, live, ROUTES, WELLS);
    await expect(commitCanonicalAssignmentWrite({
      profileRef: ref,
      driverId: DRIVER_A,
      expectedPreviewContextDigest: digest,
      proposedRoutes: ROUTES,
      proposedWells: WELLS,
      isPlatformAdmin: true,
      callerUid: ACTOR,
      nowMs: NOW,
    })).rejects.toThrow('tx_failed');
    expect(ref.listenerCount()).toBe(0);
    expect(ref.writes).toBe(0);
    expect(ref.store.value).toEqual(live);
  });

  it('success and stale-preview paths remove the listener', async () => {
    const live = baseProfile();
    const okRef = makeFakeRef(live);
    const digest = digestFor(DRIVER_A, live, ROUTES, WELLS);
    const ok = await commitCanonicalAssignmentWrite({
      ...applyArgs(okRef),
      expectedPreviewContextDigest: digest,
    });
    expect(ok.ok).toBe(true);
    expect(okRef.listenerCount()).toBe(0);

    const staleRef = makeFakeRef({ ...live, assignedRoutes: ['Other Route'] });
    const stale = await commitCanonicalAssignmentWrite({
      ...applyArgs(staleRef),
      expectedPreviewContextDigest: digest,
    });
    expect(stale).toEqual({ ok: false, reason: 'stale_preview_context' });
    expect(staleRef.listenerCount()).toBe(0);
    expect(staleRef.writes).toBe(0);
  });

  it('one request cannot remove another request’s listener', async () => {
    const live = baseProfile();
    const ref = makeFakeRef(live);
    const sentinel = () => undefined;
    ref.on('value', sentinel);
    expect(ref.hasListener(sentinel)).toBe(true);
    const digest = digestFor(DRIVER_A, live, ROUTES, WELLS);
    const applied = await commitCanonicalAssignmentWrite({
      ...applyArgs(ref),
      expectedPreviewContextDigest: digest,
    });
    expect(applied.ok).toBe(true);
    expect(ref.hasListener(sentinel)).toBe(true);
    expect(ref.listenerCount()).toBe(1);
    ref.off('value', sentinel);
    expect(ref.listenerCount()).toBe(0);
  });
});
