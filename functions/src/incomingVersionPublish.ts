/**
 * Publish-order contract for packets/incoming_version.
 *
 * Live processIncomingPull (9f75da9 and e049e2f) writes packets/outgoing
 * for accepted pulls and does not bump the counter. Edit/delete already
 * bump it with a non-atomic read/set. This helper is the shared,
 * transaction-safe increment used after outgoing status is readable.
 */

import {
  buildMaterializedEvent,
  materializedCasUpdater,
  materializedPath,
  nextIncomingVersion as safeNextIncomingVersion,
  type MaterializedKind,
} from './materializedSignal';

export function nextIncomingVersion(current: unknown): number {
  return safeNextIncomingVersion(current);
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

export type MaterializedRoot = {
  child: (path: string) => {
    set?: (value: unknown) => Promise<unknown>;
    transaction: (
      updater: (current: unknown) => unknown,
    ) => Promise<{ committed?: boolean; snapshot?: { val(): unknown } }>;
  };
};

export function shouldPublishMaterialized(input: { projectionReconciled: boolean }): boolean {
  return input.projectionReconciled === true;
}

/** Dual-write after canonical projection. CAS: older retry cannot overwrite newer. */
export async function notifyMaterializedBestEffort(
  root: MaterializedRoot,
  input: {
    companyId: string;
    wellName: string;
    kind: MaterializedKind;
    opId: string;
    packetId?: string | null;
    targetPacketId?: string | null;
    survivorPacketId?: string | null;
    resultAtMs: number;
    nowMs: number;
    projectionReconciled?: boolean;
  },
  logError: (err: unknown) => void = () => undefined,
): Promise<string | null> {
  if (input.projectionReconciled === false) return null;
  try {
    const event = buildMaterializedEvent({
      kind: input.kind,
      wellName: input.wellName,
      companyId: input.companyId,
      opId: input.opId,
      packetId: input.packetId,
      targetPacketId: input.targetPacketId,
      survivorPacketId: input.survivorPacketId,
      atMs: input.nowMs,
      resultAtMs: input.resultAtMs,
    });
    const result = await root.child(materializedPath(input.companyId, input.wellName)).transaction(
      materializedCasUpdater(event),
    );
    if (result?.committed !== true) return null;
    const stored = result.snapshot?.val() as { opId?: string } | null;
    return stored?.opId || event.opId;
  } catch (err) {
    logError(err);
    return null;
  }
}
