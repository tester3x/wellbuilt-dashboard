// Fencing-token serialization proof — the stale holder cannot commit after
// another worker takes ownership (barrier-controlled interleaving).
import { planAcquire, canCommit, planRelease, acceptFencedWrite, type FenceRecord } from '../wellFence';

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

describe('post-canCommit TOCTOU — the exact adversarial window', () => {
  test('A passes canCommit, PAUSES, lease expires, B commits, A resumes → A writes NOTHING (per-node fence CAS)', () => {
    // The canonical rows carry a chronoFence; the final write is per-node fenced.
    const rows: Record<string, { chronoFence: number; recovery: number }> = { r1: { chronoFence: 0, recovery: 10 } };
    // Apply a fenced write only if acceptFencedWrite passes (simulates the CAS transaction).
    const fencedWrite = (id: string, myFence: number, recovery: number) => {
      if (acceptFencedWrite(rows[id].chronoFence, myFence)) { rows[id] = { chronoFence: myFence, recovery }; return true; }
      return false;
    };

    // 1. A acquires fence 1 and passes the fast pre-check.
    let rec: FenceRecord = { token: 'tA', fence: 1, expiresAt: 1000 };
    expect(canCommit(rec, 'tA', 1)).toBe(true);

    // 2. A PAUSES before its multi-location write. 3. A's lease expires.
    // 4. B acquires a higher fence and COMMITS its write (fence 2 > 0 → lands).
    rec = { token: 'tB', fence: 2, expiresAt: 100000 };
    expect(fencedWrite('r1', 2, 20)).toBe(true);
    expect(rows.r1).toEqual({ chronoFence: 2, recovery: 20 });

    // 5. A RESUMES and sends its ALREADY-AUTHORIZED write stamped fence 1.
    const aLanded = fencedWrite('r1', 1, 10);
    expect(aLanded).toBe(false);              // per-node fence CAS rejects the stale write
    expect(rows.r1).toEqual({ chronoFence: 2, recovery: 20 }); // B's data intact — no lost update

    // An equal-fence retry by the CURRENT owner is idempotent.
    expect(fencedWrite('r1', 2, 20)).toBe(true);
    expect(rows.r1).toEqual({ chronoFence: 2, recovery: 20 });
  });

  test('acceptFencedWrite: lower rejected, equal idempotent, higher wins', () => {
    expect(acceptFencedWrite(2, 1)).toBe(false); // stale
    expect(acceptFencedWrite(2, 2)).toBe(true);  // retry
    expect(acceptFencedWrite(2, 3)).toBe(true);  // newer
    expect(acceptFencedWrite(undefined, 1)).toBe(true); // unset node
  });
});
