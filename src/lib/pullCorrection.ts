/**
 * Governed pull correction client.
 *
 * Replaces the legacy direct RTDB write to packets/incoming (which the deployed
 * secure rules deny — the cause of "Failed to delete pull"). All correction now
 * goes through the authenticated staffCorrectPull callable, which derives the
 * actor/company/authorization server-side. There is deliberately NO direct
 * database fallback here.
 */
import { httpsCallable, FunctionsError } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export interface PullCorrectionResult {
  ok: true;
  op: 'move' | 'delete';
  packetId: string;
  queued: boolean;
  idempotent: boolean;
  alreadyApplied: boolean;
  key?: string;
}

async function callCorrection(payload: Record<string, unknown>): Promise<PullCorrectionResult> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffCorrectPull');
  const res = await fn(payload);
  return res.data as PullCorrectionResult;
}

/** Governed delete of a pull by its immutable packetId. */
export async function deletePull(packetId: string, wellName: string): Promise<PullCorrectionResult> {
  return callCorrection({ op: 'delete', packetId, fromWell: wellName });
}

/** Governed move of a pull from the wrong well to the correct well. */
export async function movePull(
  packetId: string,
  fromWell: string,
  toWell: string,
): Promise<PullCorrectionResult> {
  return callCorrection({ op: 'move', packetId, fromWell, toWell });
}

/**
 * Turn a callable error into a short, sanitized, actionable message. Never
 * surfaces raw exception/transport text.
 */
export function describeCorrectionError(err: unknown): string {
  const code = (err as FunctionsError | undefined)?.code;
  const rawMessage = typeof (err as Error | undefined)?.message === 'string'
    ? (err as Error).message
    : '';
  // Server messages are "reason:human text"; prefer the human half.
  const reason = rawMessage.includes(':') ? rawMessage.split(':')[0] : rawMessage;
  switch (reason) {
    case 'well_mismatch':
      return 'This pull was already changed elsewhere. Refresh the page and try again.';
    case 'target_well_not_found':
      return 'The target well could not be found. Pick a different well.';
    case 'same_well':
      return 'The target well is the same as the current well.';
    case 'missing_toWell':
      return 'Choose a well to move this pull to.';
    case 'pull_not_found':
      return 'This pull no longer exists. Refresh the page.';
    case 'pool_forbidden':
    case 'manageDrivers_required':
      return 'You do not have permission to correct pulls.';
    default:
      break;
  }
  if (code === 'unauthenticated') return 'Your session expired. Sign in again and retry.';
  if (code === 'permission-denied') return 'You do not have permission to correct pulls.';
  if (code === 'unavailable' || code === 'internal' || code === 'deadline-exceeded') {
    return 'The correction service is unavailable right now. The pull was not changed — try again.';
  }
  return 'Could not complete the correction. The pull was not changed — try again.';
}
