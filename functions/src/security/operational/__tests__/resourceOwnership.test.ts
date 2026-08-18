import { decideResourceOwnership, decideThreadMembership, sameId } from '../resourceOwnership';
import { decideLease, contentDigest, canonicalReceiptKey, decideTargetLock, targetLockKey } from '../fieldCommandLease';
import { checkRateLimitDecision } from '../../rateLimit';
import { incrementRateWindow } from '../../rateLimitTxn';
import type { RateWindow } from '../../rateLimitTxn';

describe('ownership fail-closed', () => {
  it('does not treat two missing owner ids as equal', () => {
    expect(sameId(undefined, undefined)).toBe(false);
    expect(
      decideResourceOwnership({
        callerDriverId: 'a',
        callerCompanyId: 'liquid-gold',
        resourceDriverId: undefined,
        resourceCompanyId: 'liquid-gold',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_owner' });
  });

  it('rejects missing-company and cross-company and allows manager', () => {
    expect(
      decideResourceOwnership({
        callerDriverId: 'a',
        callerCompanyId: 'liquid-gold',
        resourceDriverId: 'a',
        resourceCompanyId: undefined,
      }),
    ).toMatchObject({ ok: false, reason: 'unscoped_resource' });
    expect(
      decideResourceOwnership({
        callerDriverId: 'a',
        callerCompanyId: 'liquid-gold',
        resourceDriverId: 'a',
        resourceCompanyId: 'acme-eog-test',
      }),
    ).toMatchObject({ ok: false, reason: 'cross_company' });
    expect(
      decideResourceOwnership({
        callerDriverId: 'mgr',
        callerCompanyId: 'liquid-gold',
        resourceDriverId: 'a',
        resourceCompanyId: 'liquid-gold',
        isManager: true,
      }).ok,
    ).toBe(true);
  });

  it('rejects unscoped chat and non-members', () => {
    expect(
      decideThreadMembership({
        callerDriverId: 'a',
        callerCompanyId: 'liquid-gold',
        threadCompanyId: undefined,
        participantIds: ['a'],
      }),
    ).toMatchObject({ ok: false, reason: 'unscoped_resource' });
    expect(
      decideThreadMembership({
        callerDriverId: 'a',
        callerCompanyId: 'liquid-gold',
        threadCompanyId: 'liquid-gold',
        participantIds: ['b'],
      }),
    ).toMatchObject({ ok: false, reason: 'not_member' });
  });
});

describe('receipt lease', () => {
  const intended = {
    driverId: 'a',
    companyId: 'liquid-gold',
    type: 'edit',
    targetPacketId: 'pkt',
    digest: contentDigest({ tankLevelFeet: 10 }),
    nowMs: 1000,
  };

  it('creates, exclusive-leases, duplicates committed, collides on live lease', () => {
    expect(decideLease({ exists: false }, intended).action).toBe('create');
    expect(
      decideLease(
        {
          exists: true,
          ...intended,
          status: 'leased',
          leaseOwner: 'a',
          leaseUntil: 2000,
        },
        intended,
      ).action,
    ).toBe('collision');
    expect(
      decideLease(
        { exists: true, ...intended, status: 'committed', markersPublished: true },
        intended,
      ).action,
    ).toBe('duplicate');
    expect(
      decideLease(
        {
          exists: true,
          ...intended,
          status: 'leased',
          leaseOwner: 'other',
          leaseUntil: 5000,
        },
        intended,
      ).action,
    ).toBe('collision');
    expect(
      decideLease(
        { exists: true, ...intended, status: 'applied' },
        intended,
      ).action,
    ).toBe('resume');
  });

  it('binds the key to digest so a changed client idempotency key cannot fork the op', () => {
    const a = canonicalReceiptKey({
      companyId: 'liquid-gold',
      type: 'pull',
      targetPacketId: 'p',
      digest: contentDigest({ tankLevelFeet: 1 }),
    });
    const b = canonicalReceiptKey({
      companyId: 'liquid-gold',
      type: 'pull',
      targetPacketId: 'p',
      digest: contentDigest({ tankLevelFeet: 2 }),
    });
    expect(a).not.toBe(b);
  });

  it('target lock is independent of content digest so two edits collide', () => {
    const lock = targetLockKey({ companyId: 'liquid-gold', targetPacketId: 'orig' });
    const lock2 = targetLockKey({ companyId: 'liquid-gold', targetPacketId: 'orig' });
    const lockDelete = targetLockKey({ companyId: 'liquid-gold', targetPacketId: 'orig' });
    expect(lock).toBe(lock2);
    expect(lock).toBe(lockDelete);
    expect(
      decideTargetLock(
        { exists: true, leaseUntil: 5000, attemptToken: 'a' },
        { attemptToken: 'b', nowMs: 1000 },
      ),
    ).toBe('collision');
    expect(
      decideTargetLock(
        { exists: true, leaseUntil: 500, attemptToken: 'a' },
        { attemptToken: 'b', nowMs: 1000 },
      ),
    ).toBe('acquire');
    expect(
      decideTargetLock(
        { exists: true, leaseUntil: 5000, attemptToken: 'a' },
        { attemptToken: 'a', nowMs: 1000 },
      ),
    ).toBe('reacquire_same');
  });
});

describe('transactional rate limit', () => {
  it('allows exactly N of N+K serialized increments', async () => {
    const box: { win: RateWindow | null } = { win: null };
    const txn = async (fn: (cur: RateWindow | null) => RateWindow) => {
      box.win = fn(box.win);
      return box.win;
    };
    let allowed = 0;
    for (let i = 0; i < 12; i++) {
      if (await checkRateLimitDecision({
        bucket: 't',
        key: 'k',
        limit: 5,
        windowMs: 10_000,
        nowMs: 1000,
        runTransaction: txn,
      })) allowed++;
    }
    expect(allowed).toBe(5);
    expect(box.win && box.win.count).toBe(12);
    expect(incrementRateWindow(null, 1, 10).count).toBe(1);
  });

  it('allows exactly N of N+K simultaneous transactional callers', async () => {
    const box: { win: RateWindow | null } = { win: null };
    let chain = Promise.resolve();
    const txn = (fn: (cur: RateWindow | null) => RateWindow) => {
      const run = chain.then(() => {
        box.win = fn(box.win);
        return box.win;
      });
      chain = run.then(() => undefined);
      return run;
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        checkRateLimitDecision({
          bucket: 't',
          key: 'concurrent',
          limit: 5,
          windowMs: 10_000,
          nowMs: 1000,
          runTransaction: txn,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(results.filter((v) => !v)).toHaveLength(7);
    expect(box.win && box.win.count).toBe(12);
  });
});
