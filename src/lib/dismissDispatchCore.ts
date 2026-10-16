/**
 * Firebase-free CORE for the governed "dismiss declined dispatch" control.
 * The thin dismissDispatch.ts wrapper supplies the real httpsCallable; tests
 * supply a mock invoker and assert name + payload + result by executing this.
 */

/** The deployed callable this control targets. */
export const DISMISS_DISPATCH_CALLABLE = 'dismissDispatch';

export interface DismissDispatchResult {
  ok: true;
  idempotent: boolean;
  dispatchIds: string[];
}

export type CallableInvoker<T> = (payload: unknown) => Promise<{ data: T }>;

export function buildDismissPayload(dispatchId: string, reason?: string): { dispatchId: string; reason?: string } {
  return { dispatchId, ...(reason !== undefined ? { reason: reason.trim() } : {}) };
}

export async function runDismissDispatch(
  invoke: CallableInvoker<DismissDispatchResult>,
  dispatchId: string,
  reason?: string,
): Promise<DismissDispatchResult> {
  const res = await invoke(buildDismissPayload(dispatchId, reason));
  return res.data;
}

/** Match the server's started-job removal guard before offering dismissal. */
export function dispatchRemovalRequiresCancellation(status: string | null | undefined): boolean {
  return ['accepted', 'in_progress', 'paused'].includes(status || '');
}
