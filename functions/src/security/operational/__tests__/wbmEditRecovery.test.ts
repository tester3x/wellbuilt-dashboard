/**
 * Stage 1.4 integration proof for the governed recovery orchestration against a
 * fake RTDB (no emulator, no index.ts). Proves the invariants the production
 * failure violated:
 *   • a gated-off recovery is REFUSED before any apply (behavior-neutral)
 *   • an accepted-then-missing edit reaches a TERMINAL applied record (+receipt)
 *   • the same editEventId is exactly-once / idempotent (single apply)
 *   • an already-applied / rejected / pending edit is never re-applied
 */
import { orchestrateGovernedRecovery, type RecoveryIO, type CanaryFlag } from '../wbmEditCanary';

const EVT = 'editevt_abc';
const WELL = 'Test Well';
const ORIG = '20260831_230250_TestWell_a6sm54';

function makeIO(over: Partial<{
  flag: CanaryFlag;
  receipt: Record<string, unknown> | null;
  rejected: Record<string, unknown> | null;
  incoming: Record<string, unknown> | null;
  claimTaken: boolean;
}> = {}) {
  const state = {
    receipt: over.receipt ?? null as Record<string, unknown> | null,
    rejected: over.rejected ?? null,
    incoming: over.incoming ?? null,
    claimTaken: over.claimTaken ?? false,
    applyCount: 0,
  };
  const flag: CanaryFlag = 'flag' in over ? over.flag : { enabled: true, allow: { [EVT]: { wellName: WELL, originalPacketId: ORIG } } };
  const io: RecoveryIO = {
    readFlag: async () => flag,
    readReceipt: async () => state.receipt,
    readRejected: async () => state.rejected,
    readIncoming: async () => state.incoming,
    claim: async () => {
      if (state.claimTaken) return false;
      state.claimTaken = true;
      return true;
    },
    apply: async () => {
      state.applyCount += 1;
      // The canonical applier writes the receipt — model that terminal record.
      state.receipt = { editEventId: EVT, appliedAt: 1 };
    },
    readReceiptAfterApply: async () => state.receipt,
  };
  return { io, state };
}

const base = { editEventId: EVT, wellName: WELL, originalPacketId: ORIG, original: { wellName: WELL, tankLevelFeet: 15 } };

describe('orchestrateGovernedRecovery', () => {
  test('gate OFF ⇒ refused before any apply (behavior-neutral)', async () => {
    const { io, state } = makeIO({ flag: null });
    const r = await orchestrateGovernedRecovery({ ...base, io });
    expect(r).toEqual({ ok: false, status: 'refused', reason: 'canary_disabled:canary_flag_absent' });
    expect(state.applyCount).toBe(0);
  });

  test('missing edit + gate ON ⇒ applies exactly once and yields a terminal receipt', async () => {
    const { io, state } = makeIO();
    const r = await orchestrateGovernedRecovery({ ...base, io });
    expect(r).toEqual({ ok: true, status: 'applied', receiptWritten: true });
    expect(state.applyCount).toBe(1); // no disappearance: exactly one terminal apply
  });

  test('idempotent: a second recovery after apply returns applied, never re-applies', async () => {
    const { io, state } = makeIO();
    await orchestrateGovernedRecovery({ ...base, io }); // first: applies
    const r2 = await orchestrateGovernedRecovery({ ...base, io }); // second: receipt now exists
    expect(r2).toEqual({ ok: true, status: 'applied', reason: 'already_applied', idempotent: true });
    expect(state.applyCount).toBe(1);
  });

  test('a lost claim race (already claimed) ⇒ claimed, no apply', async () => {
    const { io, state } = makeIO({ claimTaken: true });
    const r = await orchestrateGovernedRecovery({ ...base, io });
    expect(r).toEqual({ ok: true, status: 'claimed', reason: 'recovery_already_claimed', idempotent: true });
    expect(state.applyCount).toBe(0);
  });

  test('already applied / rejected / pending ⇒ never re-applies', async () => {
    for (const over of [{ receipt: { a: 1 } }, { rejected: { reason: 'x' } }, { incoming: { a: 1 } }]) {
      const { io, state } = makeIO(over);
      const r = await orchestrateGovernedRecovery({ ...base, io });
      expect(r.ok).toBe(true);
      expect((r as { idempotent?: boolean }).idempotent).toBe(true);
      expect(state.applyCount).toBe(0);
    }
  });
});
