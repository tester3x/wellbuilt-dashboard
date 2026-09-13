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

export function buildDismissPayload(dispatchId: string): { dispatchId: string } {
  return { dispatchId };
}

export async function runDismissDispatch(
  invoke: CallableInvoker<DismissDispatchResult>,
  dispatchId: string,
): Promise<DismissDispatchResult> {
  const res = await invoke(buildDismissPayload(dispatchId));
  return res.data;
}
