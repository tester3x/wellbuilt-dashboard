/**
 * Firebase-free CORE for the governed Dashboard pull DELETE.
 *
 * This module holds the parts of the delete control that can be exercised at
 * runtime without the Firebase SDK: the exact callable name, the payload
 * builder, the result unwrap, and the sanitized error mapping. The thin
 * `pullDelete.ts` wrapper supplies the real httpsCallable invoker; tests supply
 * a mock invoker and assert the full contract (name + payload + success/failure)
 * by actually running this code — not by reading source.
 *
 * Mirrors the established pullEditCore.ts pattern. No firebase import at runtime
 * (the FunctionsError type is `import type`, stripped by the compiler).
 */
import type { FunctionsError } from 'firebase/functions';

/** The deployed callable this control targets. */
export const DELETE_PULL_CALLABLE = 'staffDeletePull';

export interface DeletePullResult {
  ok: true;
  packetId: string;
  queued: boolean;
  idempotent: boolean;
  alreadyApplied: boolean;
  key?: string;
}

/** A callable invoker: real one wraps httpsCallable; tests pass a mock. */
export type CallableInvoker<T> = (payload: unknown) => Promise<{ data: T }>;

/** The exact wire payload the deployed staffDeletePull expects. */
export function buildDeletePayload(packetId: string, wellName: string): { packetId: string; wellName: string } {
  return { packetId, wellName };
}

/** Run the governed delete through an injected invoker and unwrap the result. */
export async function runDeletePull(
  invoke: CallableInvoker<DeletePullResult>,
  packetId: string,
  wellName: string,
): Promise<DeletePullResult> {
  const res = await invoke(buildDeletePayload(packetId, wellName));
  return res.data;
}

/**
 * Turn a callable error into a short, sanitized, actionable message. Never
 * surfaces raw exception/transport text.
 */
export function describeDeleteError(err: unknown): string {
  const sdkCode = (err as FunctionsError | undefined)?.code;
  const code = typeof sdkCode === 'string' ? sdkCode.replace(/^(functions|auth)\//, '') : '';
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
  if (['unauthenticated', 'user-token-expired', 'id-token-expired', 'user-disabled'].includes(code)) return 'Your session expired. Sign in again and retry.';
  if (code === 'permission-denied') return 'You do not have permission to delete pulls.';
  if (['unavailable', 'internal', 'deadline-exceeded', 'network-request-failed'].includes(code) ||
      (err instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(rawMessage))) {
    // A lost response can follow a committed delete. Never assert unchanged.
    return 'The connection or delete service was interrupted. Refresh to confirm whether the pull was deleted, then retry if it remains.';
  }
  return 'Could not confirm the delete. Refresh the history, then retry if the pull remains.';
}
