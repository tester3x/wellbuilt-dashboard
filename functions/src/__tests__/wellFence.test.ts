// Fencing-token serialization proof — the stale holder cannot commit after
// another worker takes ownership (barrier-controlled interleaving).
import { planAcquire, canCommit, planRelease, type FenceRecord } from '../wellFence';

const LEASE = 30_000;

describe('planAcquire — monotonic fence + lease', () => {
  test('acquire on empty → fence 1', () => {
    const d = planAcquire(null, 'tA', 1000, LEASE);
    expect(d.decision).toBe('acquire');
    if (d.decision === 'acquire') { expect(d.next).toEqual({ token: 'tA', fence: 1, expiresAt: 1000 + LEASE }); }
  });
  test('held + unexpired by another → contended', () => {
    const cur: FenceRecord = { token: 'tA', fence: 1, expiresAt: 100_000 };
    const d = planAcquire(cur, 'tB', 5000, LEASE);
    expect(d).toMatchObject({ decision: 'contended', heldBy: 'tA' });
  });
  test('expired → next owner gets a STRICTLY greater fence', () => {
    const cur: FenceRecord = { token: 'tA', fence: 7, expiresAt: 1000 };
    const d = planAcquire(cur, 'tB', 2000, LEASE); // now past expiry
    expect(d.decision).toBe('acquire');
    if (d.decision === 'acquire') { expect(d.next.token).toBe('tB'); expect(d.next.fence).toBe(8); }
  });
});

describe('fencing guarantee — stale holder cannot commit after ownership changes', () => {
  test('A pauses, lease expires, B takes ownership, A resumes → only B can commit', () => {
    // Shared fence record (the "server").
    let rec: FenceRecord | null = null;

    // 1. A acquires at t=1000.
    const aDec = planAcquire(rec, 'tA', 1000, LEASE);
    expect(aDec.decision).toBe('acquire');
    rec = (aDec as { next: FenceRecord }).next;
    const aToken = 'tA', aFence = rec.fence; // 1

    // 2. A PAUSES before commit. Time advances past A's lease.
    const laterMs = rec.expiresAt + 1;

    // 3. B acquires ownership (A's lease expired) → new token, higher fence.
    const bDec = planAcquire(rec, 'tB', laterMs, LEASE);
    expect(bDec.decision).toBe('acquire');
    rec = (bDec as { next: FenceRecord }).next;
    const bToken = 'tB', bFence = rec.fence; // 2
    expect(bFence).toBeGreaterThan(aFence);

    // 4. B commits — its token/fence still current → allowed.
    expect(canCommit(rec, bToken, bFence)).toBe(true);

    // 5. A RESUMES and tries to commit with its stale token/fence → REFUSED.
    expect(canCommit(rec, aToken, aFence)).toBe(false);
  });

  test('renewal keeps the SAME token but a fresh fence; a commit at the OLD fence is refused', () => {
    let rec: FenceRecord | null = planAcquire(null, 'tA', 1000, LEASE).decision === 'acquire'
      ? (planAcquire(null, 'tA', 1000, LEASE) as { next: FenceRecord }).next : null;
    const oldFence = rec!.fence; // 1
    // A renews (heartbeat) before expiry → same token, bumped fence.
    const renew = planAcquire(rec, 'tA', 2000, LEASE);
    rec = (renew as { next: FenceRecord }).next;
    expect(rec.token).toBe('tA');
    expect(rec.fence).toBe(oldFence + 1); // 2
    // A commit stamped with the OLD fence is refused; the CURRENT fence commits.
    expect(canCommit(rec, 'tA', oldFence)).toBe(false);
    expect(canCommit(rec, 'tA', rec.fence)).toBe(true);
  });

  test('release never clobbers a newer owner', () => {
    const rec: FenceRecord = { token: 'tB', fence: 2, expiresAt: 999999 };
    // A (old owner) tries to release → must leave B's record intact.
    expect(planRelease(rec, 'tA')).toBe(rec);
    // B releases its own → cleared.
    expect(planRelease(rec, 'tB')).toBeNull();
  });
});
