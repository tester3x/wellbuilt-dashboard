/**
 * Phase-two owner materialization transaction for processIncomingPull.
 *
 * P0 (2026-09-07): the Admin SDK runs a transaction's update function against
 * the LOCAL cache first, which — with no active listener — is null even though
 * the server node already exists (written by the phase-one high-water CAS in the
 * same run). The previous code returned an abort on that optimistic null-first
 * invocation, so the transaction aborted BEFORE the authoritative server value
 * was read and the rightful owner could never materialize its current-state.
 *
 * Fix: on the optimistic null read, keep the transaction alive (return a value)
 * so the SDK re-runs against the server node; only decide abort/commit from the
 * real server value. The ownership comparison itself is unchanged (fail closed
 * on absent/other owner). Extracted here so the exact production path is unit-
 * and emulator-testable.
 */
import { applyCurrentStateIfOwner } from './packetGuards';

export type MaterializeOutcome = 'materialized' | 'already' | 'superseded' | 'no_owner';

/** Structural shape of an RTDB Reference's transaction — lets tests inject a fake. */
export interface TxnRef {
  transaction(
    update: (node: unknown) => unknown,
  ): Promise<{ committed: boolean; snapshot?: { val(): unknown } | null }>;
}

export async function runOwnerMaterializeTxn(input: {
  ref: TxnRef;
  packetId: string;
  current: Record<string, unknown>;
  /** Optional structured-log hook. Fires 'retry' on each optimistic-null pass
   *  and once with the final outcome. */
  onEvent?: (event: MaterializeOutcome | 'retry') => void;
}): Promise<{ materialized: boolean; outcome: MaterializeOutcome }> {
  const box: { outcome: MaterializeOutcome } = { outcome: 'no_owner' };
  const txn = await input.ref.transaction((node) => {
    const decision = applyCurrentStateIfOwner({
      node: node as never,
      packetId: input.packetId,
      current: input.current,
    });
    if (decision.action === 'retry') {
      // Keep the transaction alive so the SDK re-runs against the server node.
      // The {} only persists when the server GENUINELY has no node (no owner →
      // fail closed); otherwise the conflicting write forces a server re-run.
      input.onEvent?.('retry');
      box.outcome = 'no_owner';
      return node == null ? {} : (node as Record<string, unknown>);
    }
    if (decision.action === 'abort') {
      box.outcome = 'superseded';
      return undefined; // real, server-seen non-owner → never materialize
    }
    box.outcome = decision.already ? 'already' : 'materialized';
    return decision.next;
  });
  const materialized =
    !!txn.committed && (box.outcome === 'materialized' || box.outcome === 'already');
  input.onEvent?.(box.outcome);
  return { materialized, outcome: box.outcome };
}
