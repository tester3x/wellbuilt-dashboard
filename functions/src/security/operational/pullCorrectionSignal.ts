/**
 * Governed confirmed pull correction signal.
 *
 * Emits a durable revision on the driver-visible `dispatches/{dispatchId}`
 * document ONLY after the corrected outgoing well row in RTDB `packets/outgoing`
 * has been successfully updated.
 *
 * Scope: authenticated company, driver, well.
 * Identity: originalPacketId + content revision hash of (bottomLevel, pullDateTimeUTC, flowRate).
 */
import * as crypto from 'crypto';
import type * as admin from 'firebase-admin';

export interface PullCorrectionSignal {
  packetId: string;
  revision: string;
  bottomLevel: string;
  pullDateTimeUTC: string;
  flowRate: string;
  publishedAtMs: number;
  publishedAt?: any;
  wellName: string;
  companyId: string;
  driverId: string | null;
}

/**
 * Computes a deterministic revision identifier for a pull's published state.
 * Changes whenever measured bottom, pull time, or flow rate changes.
 * Preserves the original pull packet ID as its prefix.
 */
export function computePullRevision(
  packetId: string,
  bottomLevel: string,
  pullDateTimeUTC: string,
  flowRate: string,
): string {
  const pid = String(packetId || '').trim();
  const bottom = String(bottomLevel || '').trim();
  const time = String(pullDateTimeUTC || '').trim();
  const flow = String(flowRate || '').trim();
  const digest = crypto
    .createHash('sha256')
    .update(`${pid}|${bottom}|${time}|${flow}`)
    .digest('hex')
    .slice(0, 12);
  return `${pid}:r_${digest}`;
}

export interface EvaluatePullCorrectionInput {
  isLatestPull: boolean;
  outgoingUpdated: boolean;
  packetId: string;
  wellName: string;
  companyId: string;
  driverId: string | null;
  bottomLevel: string;
  pullDateTimeUTC: string;
  flowRate: string;
  existingRevision?: string | null;
}

export type EvaluatePullCorrectionResult =
  | {
      action: 'publish';
      revision: string;
      signal: PullCorrectionSignal;
    }
  | {
      action: 'skip';
      reason:
        | 'not_latest_pull'
        | 'outgoing_not_updated'
        | 'already_published'
        | 'invalid_packet_id'
        | 'invalid_measurements';
    };

/**
 * Pure evaluator for deciding whether a confirmed pull correction must be published.
 * Fails closed if:
 *  - the pull is not the latest pull for the well,
 *  - the outgoing row was not yet confirmed updated,
 *  - packetId or measurement fields are missing/invalid,
 *  - the revision is already identical to the existing revision (idempotent replay).
 */
export function evaluatePullCorrectionPublication(
  input: EvaluatePullCorrectionInput,
): EvaluatePullCorrectionResult {
  if (!input.isLatestPull) {
    return { action: 'skip', reason: 'not_latest_pull' };
  }
  if (!input.outgoingUpdated) {
    return { action: 'skip', reason: 'outgoing_not_updated' };
  }
  const pid = String(input.packetId || '').trim();
  if (!pid) {
    return { action: 'skip', reason: 'invalid_packet_id' };
  }
  const bottom = String(input.bottomLevel || '').trim();
  const time = String(input.pullDateTimeUTC || '').trim();
  const flow = String(input.flowRate || '').trim();
  if (!bottom || !time || !flow || flow === 'Unknown') {
    return { action: 'skip', reason: 'invalid_measurements' };
  }
  const revision = computePullRevision(pid, bottom, time, flow);
  if (input.existingRevision === revision) {
    return { action: 'skip', reason: 'already_published' };
  }
  return {
    action: 'publish',
    revision,
    signal: {
      packetId: pid,
      revision,
      bottomLevel: bottom,
      pullDateTimeUTC: time,
      flowRate: flow,
      publishedAtMs: Date.now(),
      wellName: input.wellName,
      companyId: input.companyId,
      driverId: input.driverId,
    },
  };
}

/**
 * Builds the atomic update patch to apply to a driver's dispatches document.
 */
export function buildDispatchCorrectionPatch(
  signal: PullCorrectionSignal,
  serverTimestamp?: any,
): Record<string, unknown> {
  const ts = serverTimestamp || new Date().toISOString();
  return {
    lastPullPacketId: signal.packetId,
    lastPullRevision: signal.revision,
    lastPullBottomLevel: signal.bottomLevel,
    lastPullDateTimeUTC: signal.pullDateTimeUTC,
    flowRate: signal.flowRate,
    lastPullCorrection: {
      packetId: signal.packetId,
      revision: signal.revision,
      bottomLevel: signal.bottomLevel,
      pullDateTimeUTC: signal.pullDateTimeUTC,
      flowRate: signal.flowRate,
      publishedAt: ts,
      publishedAtMs: signal.publishedAtMs,
      wellName: signal.wellName,
      companyId: signal.companyId,
      driverId: signal.driverId,
    },
    lastPullPacketAt: ts,
  };
}

export interface DispatchLookupHints {
  dispatchId?: string | null;
  ticketDispatchId?: string | null;
  invoiceDispatchId?: string | null;
  packetId: string;
  companyId?: string | null;
  wellName?: string | null;
  driverId?: string | null;
}

/**
 * Resolves dispatch document IDs associated with a pull packet.
 * Checks direct hints first, then queries by packet identity.
 */
export async function findDispatchIdsForPull(
  firestore: admin.firestore.Firestore,
  hints: DispatchLookupHints,
): Promise<string[]> {
  const ids = new Set<string>();
  const explicitId = (hints.dispatchId || hints.ticketDispatchId || hints.invoiceDispatchId || '').trim();
  if (explicitId) {
    ids.add(explicitId);
    return Array.from(ids);
  }

  const pid = (hints.packetId || '').trim();
  if (!pid) return [];

  try {
    const snapLast = await firestore.collection('dispatches')
      .where('lastPullPacketId', '==', pid)
      .get();
    snapLast.forEach((d) => ids.add(d.id));

    if (ids.size === 0) {
      const snapArray = await firestore.collection('dispatches')
        .where('pullPacketIds', 'array-contains', pid)
        .get();
      snapArray.forEach((d) => ids.add(d.id));
    }
  } catch (err) {
    console.warn('[pullCorrectionSignal] findDispatchIdsForPull query error:', err);
  }

  return Array.from(ids);
}

/**
 * Applies the verified confirmed pull correction signal to target dispatches documents.
 * Verifies company containment and enforces idempotency (no-op if revision matches).
 */
export async function publishPullCorrectionToDispatches(
  firestore: admin.firestore.Firestore,
  options: {
    dispatchIds: string[];
    signal: PullCorrectionSignal;
    serverTimestamp?: any;
    arrayUnion?: (val: unknown) => any;
  },
): Promise<{ ok: boolean; revision: string; updatedDispatchIds: string[]; skipped?: string }> {
  if (!options.dispatchIds || options.dispatchIds.length === 0) {
    return { ok: false, revision: options.signal.revision, updatedDispatchIds: [], skipped: 'no_dispatch_ids' };
  }

  const patch = buildDispatchCorrectionPatch(options.signal, options.serverTimestamp);
  const updatedDispatchIds: string[] = [];

  for (const did of options.dispatchIds) {
    try {
      const docRef = firestore.collection('dispatches').doc(did);
      const docSnap = await docRef.get();
      if (!docSnap.exists) continue;
      const data = docSnap.data() || {};

      // Company scoping check
      if (options.signal.companyId && data.companyId && data.companyId !== options.signal.companyId) {
        console.warn(`[pullCorrectionSignal] dispatch ${did} company mismatch: ${data.companyId} !== ${options.signal.companyId}`);
        continue;
      }

      // Driver scoping check
      if (options.signal.driverId) {
        const dispDriver = data.driverId || data.driverHash || data.assignedDriverId;
        if (dispDriver && dispDriver !== options.signal.driverId) {
          console.warn(`[pullCorrectionSignal] dispatch ${did} driver mismatch: ${dispDriver} !== ${options.signal.driverId}`);
          continue;
        }
      }

      // Well scoping check
      if (options.signal.wellName) {
        const dispWell = data.wellName || data.well;
        if (dispWell && dispWell.trim().toLowerCase() !== options.signal.wellName.trim().toLowerCase()) {
          console.warn(`[pullCorrectionSignal] dispatch ${did} well mismatch: ${dispWell} !== ${options.signal.wellName}`);
          continue;
        }
      }

      // Idempotency check: if this dispatch already has this exact revision, skip writing again
      if (data.lastPullRevision === options.signal.revision) {
        updatedDispatchIds.push(did);
        continue;
      }

      const updateData: Record<string, unknown> = { ...patch };
      if (options.arrayUnion) {
        updateData.pullPacketIds = options.arrayUnion(options.signal.packetId);
      }
      await docRef.update(updateData);
      updatedDispatchIds.push(did);
    } catch (err) {
      console.warn(`[pullCorrectionSignal] error updating dispatch ${did}:`, err);
    }
  }

  return {
    ok: updatedDispatchIds.length > 0,
    revision: options.signal.revision,
    updatedDispatchIds,
    skipped: updatedDispatchIds.length === 0 ? 'all_dispatches_filtered_or_missing' : undefined,
  };
}
