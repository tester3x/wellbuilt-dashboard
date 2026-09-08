/**
 * Governed Dashboard pull DELETE client.
 *
 * Replaces the legacy direct RTDB write to packets/incoming (which the deployed
 * secure rules deny — the cause of "Failed to delete pull"). Delete now goes
 * through the authenticated staffDeletePull callable, which derives the
 * actor/company/authorization server-side. There is deliberately NO direct
 * database fallback here.
 */
import { httpsCallable, FunctionsError } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export interface DeletePullResult {
  ok: true;
  packetId: string;
  queued: boolean;
  idempotent: boolean;
  alreadyApplied: boolean;
  key?: string;
}

/** Governed delete of a pull by its immutable packetId + its (scope) well. */
export async function deletePull(packetId: string, wellName: string): Promise<DeletePullResult> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffDeletePull');
  const res = await fn({ packetId, wellName });
  return res.data as DeletePullResult;
}

/**
 * Turn a callable error into a short, sanitized, actionable message. Never
 * surfaces raw exception/transport text.
 */
export function describeDeleteError(err: unknown): string {
  const code = (err as FunctionsError | undefined)?.code;
  const rawMessage = typeof (err as Error | undefined)?.message === 'string'
    ? (err as Error).message
    : '';
  // Server messages are "reason:human text"; key off the reason half.
  const reason = rawMessage.includes(':') ? rawMessage.split(':')[0] : rawMessage;
  switch (reason) {
    case 'well_mismatch':
      return 'This pull was already changed elsewhere. Refresh the page and try again.';
    case 'pool_forbidden':
    case 'manageDrivers_required':
      return 'You do not have permission to delete pulls.';
    case 'invalid_packetId':
    case 'missing_wellName':
      return 'This pull could not be identified. Refresh the page and try again.';
    case 'delete_conflict':
      return 'Another delete for this pull is already in progress. Try again in a moment.';
    default:
      break;
  }
  if (code === 'unauthenticated') return 'Your session expired. Sign in again and retry.';
  if (code === 'permission-denied') return 'You do not have permission to delete pulls.';
  if (code === 'unavailable' || code === 'internal' || code === 'deadline-exceeded') {
    return 'The delete service is unavailable right now. The pull was not deleted — try again.';
  }
  return 'Could not delete the pull. It was not changed — try again.';
}
