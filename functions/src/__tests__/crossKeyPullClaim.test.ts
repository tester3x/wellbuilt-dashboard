import {
  commitPullClaim,
  counterpartStorageKey,
  crossKeyClaimUpdate,
  logicalPullId,
  markPullClaimApplied,
  PULL_EXECUTION_LEASE_MS,
  shouldApplyCrossKeyGuard,
  type PullClaim,
  type PullIdentity,
} from '../security/operational/crossKeyPullClaim';

const BARE = '20260927_223147_TestWell_885098';
const IDEM = `idem_${BARE}`;

const T0 = 1_000_000;

function attempt(token: string, nowMs = T0, processedExists = false) {
  return { nowMs, executionToken: token, processedExists };
}

function identity(storageKey: string, over: Partial<PullIdentity> = {}): PullIdentity {
  return {
    storageKey,
    companyId: 'co-1',
    driverId: 'drv-1',
    wellName: 'Test Well',
    bblsTaken: 20,
    tankLevelFeet: 9,
    ...over,
  };
}

describe('cross-key pull claim', () => {
  test('idem_ first then bare retires the bare twin', () => {
    const first = crossKeyClaimUpdate(null, identity(IDEM), attempt('idem'));
    expect(first.outcome).toBe('proceed');
    const second = crossKeyClaimUpdate(first.next, identity(BARE), attempt('bare'));
    expect(second.outcome).toBe('retire');
    expect(second.next?.winnerKey).toBe(IDEM);
  });

  test('bare first then idem_ retires the idem_ twin', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE), attempt('bare'));
    const second = crossKeyClaimUpdate(first.next, identity(IDEM), attempt('idem'));
    expect(second.outcome).toBe('retire');
    expect(second.next).toEqual(first.next);
  });

  test('concurrent arrivals: the transaction loser sees the winner and retires', async () => {
    const box: { claim: PullClaim | null } = { claim: null };
    const ref = {
      async transaction(update: (current: PullClaim | null) => PullClaim | null) {
        box.claim = update(box.claim);
        const committed = box.claim;
        return { snapshot: { val: () => committed } };
      },
    };
    const [a, b] = await Promise.all([
      commitPullClaim(ref, identity(BARE)),
      commitPullClaim(ref, identity(IDEM)),
    ]);
    expect([a, b].sort()).toEqual(['proceed', 'retire']);
    expect(box.claim?.logicalId).toBe(BARE);
  });

  test('a finished same-key replay does not enter the write chain again', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE), attempt('t1'));
    const applied = markPullClaimApplied(first.next, BARE);
    const retry = crossKeyClaimUpdate(applied, identity(BARE), attempt('t2'));
    expect(retry.outcome).toBe('retire');
    expect(retry.next?.phase).toBe('applied');
    expect(retry.next?.executionToken).toBeNull();
  });

  test('a second same-key invocation waits while the first lease is active', async () => {
    const box: { claim: PullClaim | null } = { claim: null };
    const ref = {
      async transaction(update: (current: PullClaim | null) => PullClaim | null) {
        box.claim = update(box.claim);
        const committed = box.claim;
        return { snapshot: { val: () => committed } };
      },
    };
    const writes: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const run = async (token: string) => {
      const outcome = await commitPullClaim(ref, identity(BARE), attempt(token));
      if (outcome !== 'proceed') return outcome;
      await gate;
      writes.push(token);
      await ref.transaction((current) => markPullClaimApplied(current, BARE) || current);
      return 'wrote' as const;
    };
    const first = run('t1');
    await Promise.resolve();
    const second = await run('t2');
    expect(second).toBe('busy');
    expect(writes).toEqual([]);
    releaseFirst();
    expect(await first).toBe('wrote');
    expect(writes).toEqual(['t1']);
  });

  test('an expired lease can recover only when the processed row is absent', async () => {
    const box: { claim: PullClaim | null } = { claim: null };
    const ref = {
      async transaction(update: (current: PullClaim | null) => PullClaim | null) {
        box.claim = update(box.claim);
        const committed = box.claim;
        return { snapshot: { val: () => committed } };
      },
    };
    const writes: string[] = [];
    const first = await commitPullClaim(ref, identity(BARE), attempt('t1', T0));
    expect(first).toBe('proceed');
    writes.push('processed');
    const expired = T0 + PULL_EXECUTION_LEASE_MS + 1;
    const crashed = await commitPullClaim(ref, identity(BARE), attempt('t2', expired, true));
    expect(crashed).toBe('retire');
    expect(writes).toEqual(['processed']);
    expect(box.claim?.phase).toBe('claimed');
    const fresh = await commitPullClaim(ref, identity(BARE), attempt('t3', expired, false));
    expect(fresh).toBe('proceed');
    expect(box.claim?.executionToken).toBe('t3');
  });

  test('different barrels are a conflict and the winner is kept', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE), attempt('bare'));
    const second = crossKeyClaimUpdate(first.next, identity(IDEM, { bblsTaken: 40 }), attempt('idem'));
    expect(second.outcome).toBe('conflict');
    expect(second.next?.bblsTaken).toBe(20);
  });

  test('another company is not retired as the same pull', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE), attempt('bare'));
    const second = crossKeyClaimUpdate(first.next, identity(IDEM, { companyId: 'co-2' }), attempt('idem'));
    expect(second.outcome).toBe('cross_tenant');
    expect(second.next?.companyId).toBe('co-1');
  });

  test('an edit is not a cross-key pull', () => {
    expect(shouldApplyCrossKeyGuard('edit')).toBe(false);
    expect(shouldApplyCrossKeyGuard('delete')).toBe(false);
    expect(shouldApplyCrossKeyGuard('pull')).toBe(true);
    expect(shouldApplyCrossKeyGuard(undefined)).toBe(true);
  });

  test('a later distinct id is a new claim', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE), attempt('bare'));
    expect(logicalPullId(IDEM)).toBe(BARE);
    expect(counterpartStorageKey(BARE)).toBe(IDEM);
    expect(first.next?.logicalId).not.toBe(logicalPullId('20260927_230000_TestWell_999999'));
  });
});
