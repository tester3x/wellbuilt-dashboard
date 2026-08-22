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

function makeFakeRef(initial: Record<string, unknown> | null): AssignmentProfileRef & {
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
      _cancel?: (err: Error) => void,
    ) {
      listeners.add(callback);
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
});
