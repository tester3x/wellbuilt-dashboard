/**
 * Atomic bidirectional identity binding write.
 *
 * Transactions run on the parent `drivers/identityBindings` path so both
 * byDriver and byApproved records commit together. One-sided state is
 * never treated as already_exact. Injected failAfter supports partial-write
 * tests against the in-memory adapter.
 */
import {
  BINDING_ROOT,
  decideBindIdentity,
  parseBinding,
  type BindingStatus,
  type IdentityBinding,
} from './identityBinding';

export type BindingsTreeRef = {
  on(
    event: 'value',
    callback: (...args: unknown[]) => void,
    cancelCallback?: (err: Error) => void,
  ): unknown;
  off(event: 'value', callback?: (...args: unknown[]) => void): void;
  transaction(
    update: (current: unknown) => unknown,
  ): Promise<{
    committed: boolean;
    snapshot: { exists(): boolean; val(): unknown };
  }>;
};

export type BindingWriteResult =
  | { ok: true; action: 'written' | 'repaired' | 'already_exact'; binding: IdentityBinding }
  | { ok: false; reason: string };

export function evaluateBindingTreeWrite(input: {
  tree: unknown;
  driverId: string;
  approvedKey: string;
  status: BindingStatus;
  opId: string;
}): { decision: ReturnType<typeof decideBindIdentity>; nextTree?: Record<string, unknown> } {
  const tree = input.tree && typeof input.tree === 'object' && !Array.isArray(input.tree)
    ? { ...(input.tree as Record<string, unknown>) }
    : {};
  const byDriver = (tree.byDriver && typeof tree.byDriver === 'object' && !Array.isArray(tree.byDriver))
    ? { ...(tree.byDriver as Record<string, unknown>) }
    : {};
  const byApproved = (tree.byApproved && typeof tree.byApproved === 'object' && !Array.isArray(tree.byApproved))
    ? { ...(tree.byApproved as Record<string, unknown>) }
    : {};
  const decision = decideBindIdentity({
    driverId: input.driverId,
    approvedKey: input.approvedKey,
    status: input.status,
    opId: input.opId,
    existingByDriver: parseBinding(byDriver[input.driverId]),
    existingByApproved: parseBinding(byApproved[input.approvedKey]),
  });
  if (decision.action === 'refuse' || decision.action === 'already_exact') {
    return { decision };
  }
  const payload = decision.payload;
  byDriver[payload.driverId] = { ...payload };
  byApproved[payload.approvedKey] = { ...payload };
  return {
    decision,
    nextTree: { ...tree, byDriver, byApproved },
  };
}

export async function commitIdentityBindingWrite(input: {
  bindingsRef: BindingsTreeRef;
  driverId: string;
  approvedKey: string;
  status: BindingStatus;
  opId: string;
}): Promise<BindingWriteResult> {
  let abortReason = 'binding_aborted';
  let action: 'written' | 'repaired' | 'already_exact' = 'written';
  let payload: IdentityBinding | null = null;
  let resolvePrime: () => void = () => undefined;
  const listener = () => { resolvePrime(); };
  try {
    await new Promise<void>((resolve, reject) => {
      resolvePrime = resolve;
      input.bindingsRef.on('value', listener, (err) => reject(err));
    });
    const tx = await input.bindingsRef.transaction((current) => {
      const evaluated = evaluateBindingTreeWrite({
        tree: current,
        driverId: input.driverId,
        approvedKey: input.approvedKey,
        status: input.status,
        opId: input.opId,
      });
      if (evaluated.decision.action === 'refuse') {
        abortReason = evaluated.decision.reason;
        return;
      }
      if (evaluated.decision.action === 'already_exact') {
        abortReason = 'already_exact';
        action = 'already_exact';
        payload = {
          driverId: input.driverId,
          approvedKey: input.approvedKey,
          status: input.status,
          opId: input.opId,
        };
        return;
      }
      action = evaluated.decision.action === 'repair' ? 'repaired' : 'written';
      payload = evaluated.decision.payload;
      return evaluated.nextTree;
    });
    if (!tx.committed) {
      if (abortReason === 'already_exact' && payload) {
        return { ok: true, action: 'already_exact', binding: payload };
      }
      return { ok: false, reason: abortReason };
    }
    return { ok: true, action, binding: payload! };
  } finally {
    input.bindingsRef.off('value', listener);
  }
}

export const BINDING_ROOT_PATH = BINDING_ROOT;
