/**
 * Publish-order contract for packets/incoming_version.
 *
 * Live processIncomingPull (9f75da9 and e049e2f) writes packets/outgoing
 * for accepted pulls and does not bump the counter. Edit/delete already
 * bump it with a non-atomic read/set. This helper is the shared,
 * transaction-safe increment used after outgoing status is readable.
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
  const val = result?.snapshot?.val();
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}
