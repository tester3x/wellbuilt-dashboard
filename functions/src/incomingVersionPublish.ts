/**
 * Publish-order contract for packets/incoming_version.
 *
 * Live processIncomingPull (9f75da9) writes packets/outgoing for accepted
 * pulls and does not bump the counter. Edit/delete previously used a
 * non-atomic once()+set. This helper is the shared, transaction-safe
 * increment used after client-visible writes succeed. Notification
 * failures are isolated and must not replay the business mutation.
 */

export function nextIncomingVersion(current: unknown): number {
  const n = typeof current === 'number'
    ? current
    : parseInt(String(current ?? '0'), 10);
  return (Number.isFinite(n) ? n : 0) + 1;
}

export function shouldPublishIncomingVersion(input: {
  outgoingCommitted: boolean;
  pullAccepted: boolean;
}): boolean {
  return input.outgoingCommitted === true && input.pullAccepted === true;
}

export type VersionRef = {
  transaction: (
    updater: (current: unknown) => number,
  ) => Promise<{ committed?: boolean; snapshot?: { val(): unknown } }>;
};

export async function publishIncomingVersionAfterOutgoing(
  versionRef: VersionRef,
  flags: { outgoingCommitted: boolean; pullAccepted: boolean },
): Promise<number | null> {
  if (!shouldPublishIncomingVersion(flags)) return null;
  const result = await versionRef.transaction(nextIncomingVersion);
  if (result?.committed !== true) return null;
  const val = result?.snapshot?.val();
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/** Notification after committed writes. Failures are logged, never thrown. */
export async function notifyIncomingVersionBestEffort(
  versionRef: VersionRef,
  flags: { outgoingCommitted: boolean; pullAccepted: boolean },
  logError: (err: unknown) => void = (err) => {
    const reason =
      err && typeof err === 'object' && 'reason' in err && typeof (err as { reason: unknown }).reason === 'string'
        ? (err as { reason: string }).reason
        : 'threw';
    console.error('[incoming_version] notification failed after committed writes', { reason });
  },
): Promise<number | null> {
  if (!shouldPublishIncomingVersion(flags)) return null;
  try {
    const published = await publishIncomingVersionAfterOutgoing(versionRef, flags);
    if (published == null) {
      logError({ reason: 'not_committed' });
      return null;
    }
    return published;
  } catch {
    logError({ reason: 'threw' });
    return null;
  }
}
