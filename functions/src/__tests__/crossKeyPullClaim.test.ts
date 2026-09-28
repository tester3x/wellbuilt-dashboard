import {
  commitPullClaim,
  counterpartStorageKey,
  crossKeyClaimUpdate,
  logicalPullId,
  markPullClaimApplied,
  shouldApplyCrossKeyGuard,
  type PullClaim,
  type PullIdentity,
} from '../security/operational/crossKeyPullClaim';

const BARE = '20260927_223147_TestWell_885098';
const IDEM = `idem_${BARE}`;

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
    const first = crossKeyClaimUpdate(null, identity(IDEM));
    expect(first.outcome).toBe('proceed');
    const second = crossKeyClaimUpdate(first.next, identity(BARE, { /* later clock is not a conflict */ }));
    expect(second.outcome).toBe('retire');
    expect(second.next.winnerKey).toBe(IDEM);
  });

  test('bare first then idem_ retires the idem_ twin', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE));
    const second = crossKeyClaimUpdate(first.next, identity(IDEM));
    expect(second.outcome).toBe('retire');
    expect(second.next).toEqual(first.next);
  });

  test('concurrent arrivals: the transaction loser sees the winner and retires', async () => {
    const box: { claim: PullClaim | null } = { claim: null };
    const ref = {
      async transaction(update: (current: PullClaim | null) => PullClaim) {
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

  test('same-key retry proceeds and does not replace the claim', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE));
    const applied = markPullClaimApplied(first.next, BARE);
    const retry = crossKeyClaimUpdate(applied, identity(BARE));
    expect(retry.outcome).toBe('proceed');
    expect(retry.next.phase).toBe('applied');
  });

  test('different barrels are a conflict and the winner is kept', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE));
    const second = crossKeyClaimUpdate(first.next, identity(IDEM, { bblsTaken: 40 }));
    expect(second.outcome).toBe('conflict');
    expect(second.next.bblsTaken).toBe(20);
  });

  test('another company is not retired as the same pull', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE));
    const second = crossKeyClaimUpdate(first.next, identity(IDEM, { companyId: 'co-2' }));
    expect(second.outcome).toBe('cross_tenant');
    expect(second.next.companyId).toBe('co-1');
  });

  test('an edit is not a cross-key pull', () => {
    expect(shouldApplyCrossKeyGuard('edit')).toBe(false);
    expect(shouldApplyCrossKeyGuard('delete')).toBe(false);
    expect(shouldApplyCrossKeyGuard('pull')).toBe(true);
    expect(shouldApplyCrossKeyGuard(undefined)).toBe(true);
  });

  test('a later distinct id is a new claim', () => {
    const first = crossKeyClaimUpdate(null, identity(BARE));
    expect(logicalPullId(IDEM)).toBe(BARE);
    expect(counterpartStorageKey(BARE)).toBe(IDEM);
    expect(first.next.logicalId).not.toBe(logicalPullId('20260927_230000_TestWell_999999'));
  });
});
