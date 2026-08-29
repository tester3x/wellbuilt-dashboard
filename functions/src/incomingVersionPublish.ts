/**
 * Publish-order contract for packets/incoming_version.
 *
 * Live processIncomingPull (9f75da9 and e049e2f) writes packets/outgoing
 * for accepted pulls and does not bump the counter. Edit/delete already
 * bump it with a non-atomic read/set. This helper is the shared,
 * transaction-safe increment used after outgoing status is readable.
 */

/**
 * Representable, monotonic bump for the LEGACY node (Phase 2 bridge).
 *
 * Production holds ~4.3005e20 — a float64 whose ULP is 65,536, so the historic
 * `+1` was a permanent no-op (proven live by the 2026-08-28 Gabriel 5 edit
 * log). Old installed clients persist that saturated value behind a
 * strict-greater comparison, so the node can never be reset downward; it must
 * keep producing an OBSERVABLE UPWARD change until those consumers retire.
 * The bump adapts to the stored magnitude: +1 while representable, else one
 * ULP — the smallest guaranteed-upward move at any magnitude. Never a
 * hardcoded larger constant (it stops being representable as the value grows)
 * and never ServerValue.increment (float addition server-side — the same
 * saturation no-op). Runs inside an RTDB transaction, so concurrent mutations
 * serialize and no revision signal is lost.
 */
export function nextIncomingVersion(current: unknown): number {
  const n = typeof current === 'number'
    ? current
    : parseInt(String(current ?? '0'), 10);
  const base = Number.isFinite(n) && n > 0 ? n : 0;
  const bumped = base + 1;
  if (bumped > base) return bumped;
  // Saturated: +1 fell below the ULP. Step by exactly one ULP instead.
  return base + Math.pow(2, Math.floor(Math.log2(base)) - 52);
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
