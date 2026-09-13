/**
 * Governed "dismiss declined dispatch" client (thin Firebase wrapper).
 * The testable wire contract lives in dismissDispatchCore.ts.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import { DISMISS_DISPATCH_CALLABLE, runDismissDispatch, type DismissDispatchResult } from './dismissDispatchCore';

export { DISMISS_DISPATCH_CALLABLE } from './dismissDispatchCore';
export type { DismissDispatchResult } from './dismissDispatchCore';

export async function dismissDispatch(dispatchId: string): Promise<DismissDispatchResult> {
  const fn = httpsCallable(getFirebaseFunctions(), DISMISS_DISPATCH_CALLABLE);
  return runDismissDispatch((payload) => fn(payload) as Promise<{ data: DismissDispatchResult }>, dispatchId);
}
