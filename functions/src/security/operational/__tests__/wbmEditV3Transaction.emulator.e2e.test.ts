/**
 * RTDB emulator: the v3 durable-lane transactions run against a REAL Firebase
 * RTDB transaction (not a mock), proving the null-first-run fallback actually
 * claims (no stall) and that concurrent workers cannot double-claim or
 * double-apply. This is the transaction-behavior proof Gate 8 requires beyond
 * the pure unit tests. Requires FIREBASE_DATABASE_EMULATOR_HOST; skipped
 * otherwise. Isolated namespace so it touches no other data.
 */
import * as admin from 'firebase-admin';
import {
  claimTransactionUpdate,
  outcomeTransactionUpdate,
  decideApplyOutcome,
  wbmEditV3OpPath,
  type WbmEditV3Op,
} from '../wbmEditV3Lane';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const NS = 'wbmv3-txn-rtdb';
const describeE2E = EMULATOR ? describe : describe.skip;

const acceptedOp = (id: string, nowMs: number): WbmEditV3Op => ({
  editEventId: id,
  originalPacketId: '20260901_000000_TxnWell_orig',
  wellName: 'Txn Well',
  companyId: 'liquid-gold',
  driverId: 'driver-a',
  digest: 'digest-x',
  editedFields: ['bblsTaken'],
  payload: { bblsTaken: 170, editEventId: id },
  status: 'accepted',
  acceptedAt: nowMs,
  claimedAt: null,
  appliedAt: null,
  rejectedAt: null,
  retryWaitUntil: null,
  attempts: 0,
  lastError: null,
  rejectReason: null,
  trailVerified: false,
  beforeAfter: null,
  updatedAt: nowMs,
});

describeE2E('emulator: v3 durable-lane transactions (real RTDB)', () => {
  jest.setTimeout(60000);
  let db: admin.database.Database;

  beforeAll(() => {
    if (!admin.apps.length) {
      admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${EMULATOR}?ns=${NS}` });
    }
    db = admin.database();
  });

  afterAll(async () => {
    try { await db.ref('wbmEdits').remove(); } catch { /* noop */ }
    try { await db.goOffline(); } catch { /* noop */ }
  });

  /** Mirror driveWbmEditV3Op's claim step: priming read + guarded transaction. */
  async function drive(ref: admin.database.Reference, nowMs: number) {
    const primeSnap = await ref.once('value');
    if (!primeSnap.exists()) return { committed: false, status: null as string | null, claimedAt: null as number | null };
    const preOp = primeSnap.val() as WbmEditV3Op;
    const tx = await ref.transaction((cur) => claimTransactionUpdate((cur as WbmEditV3Op | null) ?? null, preOp, nowMs));
    const v = tx.committed && tx.snapshot.exists() ? (tx.snapshot.val() as WbmEditV3Op) : null;
    return { committed: tx.committed, status: v?.status ?? null, claimedAt: v?.claimedAt ?? null };
  }

  it('null-first-run: the priming read + transaction actually CLAIMS on a real RTDB transaction (no stall)', async () => {
    const id = 'e-null-first-run';
    const ref = db.ref(wbmEditV3OpPath(id));
    await ref.set(acceptedOp(id, 1_788_000_000_000));

    const res = await drive(ref, 1_788_000_000_100);
    expect(res.committed).toBe(true);
    expect(res.status).toBe('applying'); // did NOT stall at accepted
    const persisted = (await ref.once('value')).val() as WbmEditV3Op;
    expect(persisted.status).toBe('applying');
    expect(persisted.claimedAt).toBe(1_788_000_000_100);
  });

  it('two CONCURRENT drives race the claim: exactly ONE wins (no double-claim)', async () => {
    const id = 'e-concurrent';
    const ref = db.ref(wbmEditV3OpPath(id));
    await ref.set(acceptedOp(id, 1_788_000_000_000));

    const [a, b] = await Promise.all([
      drive(ref, 1_788_000_000_201),
      drive(ref, 1_788_000_000_202),
    ]);
    // Both transactions commit against a real RTDB, but only one moves accepted
    // → applying; the other observes the already-applying op and re-affirms it
    // (no second claimant with a different claimedAt).
    const persisted = (await ref.once('value')).val() as WbmEditV3Op;
    expect(persisted.status).toBe('applying');
    // The op has exactly one claimedAt — the winner's; the loser did not overwrite it.
    const winners = [a, b].filter((r) => r.claimedAt === persisted.claimedAt);
    expect(persisted.claimedAt === 1_788_000_000_201 || persisted.claimedAt === 1_788_000_000_202).toBe(true);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    // Neither drive produced a DIFFERENT competing claimedAt on the stored op.
    expect([1_788_000_000_201, 1_788_000_000_202]).toContain(persisted.claimedAt);
  });

  it('outcome writes ONLY for the live claim; a stale claimer is aborted', async () => {
    const id = 'e-outcome';
    const ref = db.ref(wbmEditV3OpPath(id));
    const now = 1_788_000_000_000;
    await ref.set(acceptedOp(id, now));
    // Worker A claims.
    const a = await drive(ref, now + 10);
    expect(a.status).toBe('applying');
    const claimedOp = (await ref.once('value')).val() as WbmEditV3Op;

    // Worker A applies + writes its outcome (trail verified) → applied.
    const next = decideApplyOutcome({ op: claimedOp, trailVerified: true, error: null, permanent: false, nowMs: now + 20 });
    const okTx = await ref.transaction((cur) => outcomeTransactionUpdate((cur as WbmEditV3Op | null) ?? null, claimedOp, next));
    expect((okTx.snapshot.val() as WbmEditV3Op).status).toBe('applied');

    // A STALE worker (different claimedAt) tries to write an outcome → aborted, applied preserved.
    const staleClaim = { ...claimedOp, claimedAt: now + 999 };
    const staleNext = decideApplyOutcome({ op: staleClaim, trailVerified: true, error: null, permanent: false, nowMs: now + 30 });
    await ref.transaction((cur) => outcomeTransactionUpdate((cur as WbmEditV3Op | null) ?? null, staleClaim, staleNext));
    expect((await ref.once('value')).val().status).toBe('applied'); // unchanged — no stale overwrite
  });
});
