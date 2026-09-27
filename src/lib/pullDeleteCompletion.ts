/**
 * Governed completion check and bounded retry for pull deletion.
 *
 * Firebase-free and node-testable. When staff deletes a pull via staffDeletePull,
 * the callable queues a governed delete packet and returns { queued: true } before
 * the background processor removes the pull from packets/processed and recomputes
 * outgoing well status.
 *
 * To prevent presenting an old re-read as completed deletion, the UI filters out
 * pending-deleted packet IDs immediately and uses this governed completion check
 * to verify the processor has completed before clearing the pending state and
 * refreshing the governed well pool (Current Status).
 */

export interface DeleteCompletionOptions {
  /** Maximum number of polling attempts before timing out (default: 10). */
  maxAttempts?: number;
  /** Delay in milliseconds between attempts (default: 600). */
  intervalMs?: number;
  /** Check function that returns true if the packetId is still present in history. */
  isPacketPresent: (packetId: string) => Promise<boolean>;
  /** Sleep implementation for test injection. */
  sleep?: (ms: number) => Promise<void>;
}

export type DeleteCompletionResult =
  | { status: 'completed'; attempts: number }
  | { status: 'timeout'; attempts: number };

/**
 * Wait for a queued delete to be processed by polling until isPacketPresent returns false.
 */
export async function waitForDeleteCompletion(
  packetId: string,
  options: DeleteCompletionOptions,
): Promise<DeleteCompletionResult> {
  const maxAttempts = options.maxAttempts ?? 10;
  const intervalMs = options.intervalMs ?? 600;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(intervalMs);
    const present = await options.isPacketPresent(packetId);
    if (!present) {
      return { status: 'completed', attempts: attempt };
    }
  }

  return { status: 'timeout', attempts: maxAttempts };
}

/**
 * Filter pulls to omit any currently pending deletion, as well as delete audit records.
 */
export function filterVisiblePulls<T extends { packetId: string; requestType?: string; isDelete?: boolean }>(
  pulls: T[],
  pendingDeleteIds: ReadonlySet<string>,
): T[] {
  return pulls.filter((p) => {
    if (pendingDeleteIds.has(p.packetId)) return false;
    if (p.packetId.startsWith('delete_') || p.packetId.startsWith('edit_')) return false;
    if (p.requestType === 'delete' || p.isDelete === true) return false;
    return true;
  });
}
