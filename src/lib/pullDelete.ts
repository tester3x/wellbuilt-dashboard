/**
 * Governed Dashboard pull DELETE client (thin Firebase wrapper).
 *
 * Replaces the legacy direct RTDB write to packets/incoming (which the deployed
 * secure rules deny — the cause of "Failed to delete pull"). Delete goes through
 * the authenticated staffDeletePull callable, which derives the
 * actor/company/authorization server-side. There is deliberately NO direct
 * database fallback here. The testable contract lives in pullDeleteCore.ts.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import { DELETE_PULL_CALLABLE, runDeletePull, type DeletePullResult } from './pullDeleteCore';

export { describeDeleteError, DELETE_PULL_CALLABLE } from './pullDeleteCore';
export type { DeletePullResult } from './pullDeleteCore';

/** Governed delete of a pull by its immutable packetId + its (scope) well. */
export async function deletePull(packetId: string, wellName: string): Promise<DeletePullResult> {
  const fn = httpsCallable(getFirebaseFunctions(), DELETE_PULL_CALLABLE);
  return runDeletePull((payload) => fn(payload) as Promise<{ data: DeletePullResult }>, packetId, wellName);
}
