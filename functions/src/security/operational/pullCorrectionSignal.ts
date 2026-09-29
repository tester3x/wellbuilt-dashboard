/**
 * Governed confirmed pull correction signal.
 *
 * Emits a durable revision on the driver-visible `dispatches/{dispatchId}`
 * document ONLY after the corrected outgoing well row in RTDB `packets/outgoing`
 * has been successfully updated.
 *
 * Scope: authenticated company, driver, well (fails closed on all three).
 * Identity: originalPacketId + content revision hash of (bottomLevel, pullDateTimeUTC, flowRate).
 * Ordering: monotonic CAS check ensures older replays cannot overwrite newer revisions.
 */
import * as crypto from 'crypto';
import type * as admin from 'firebase-admin';

export const LEGACY_WELL_POOL_COMPANY_ID = 'liquid-gold';

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
 * Strict tenant containment check.
 * Fails closed if targetCompanyId is missing.
 * Allows legacy unstamped dispatches ONLY if targetCompanyId === LEGACY_WELL_POOL_COMPANY_ID.
 */
export function docBelongsToTenant(
  docCompanyId: string | null | undefined,
  targetCompanyId: string | undefined,
): boolean {
  if (!targetCompanyId) return false;
  if (docCompanyId === targetCompanyId) return true;
  return targetCompanyId === LEGACY_WELL_POOL_COMPANY_ID && !docCompanyId;
}

/**
 * Normalizes well names for robust, whitespace/punctuation-tolerant containment comparison.
 */
export function normalizeWellName(name: string | null | undefined): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]/g, '');
}

/**
 * Extracts all candidate driver identity keys from a dispatch document.
 */
export function extractDispatchDriverCandidates(data: Record<string, any>): string[] {
  const candidates = new Set<string>();
  if (typeof data.driverId === 'string' && data.driverId.trim()) {
    candidates.add(data.driverId.trim());
  }
  if (typeof data.driverHash === 'string' && data.driverHash.trim()) {
    candidates.add(data.driverHash.trim());
  }
  if (typeof data.assignedDriverId === 'string' && data.assignedDriverId.trim()) {
    candidates.add(data.assignedDriverId.trim());
  }
  if (Array.isArray(data.assignedDrivers)) {
    for (const item of data.assignedDrivers) {
      if (typeof item === 'string' && item.trim()) {
        candidates.add(item.trim());
      } else if (item && typeof item === 'object') {
        if (typeof item.driverId === 'string' && item.driverId.trim()) {
          candidates.add(item.driverId.trim());
        }
        if (typeof item.driverHash === 'string' && item.driverHash.trim()) {
          candidates.add(item.driverHash.trim());
        }
      }
    }
  }
  return Array.from(candidates);
}

/**
 * Resolves equivalence between two driver identity keys (e.g. canonical UUID vs legacy approved hash).
 * Checks custom resolver first, then queries RTDB identity bindings and approved profiles.
 */
export async function areDriverIdentitiesEquivalent(
  idA: string,
  idB: string,
  rtdb?: admin.database.Database | null,
  customResolver?: (a: string, b: string) => Promise<boolean>,
): Promise<boolean> {
  const cleanA = (idA || '').trim();
  const cleanB = (idB || '').trim();
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;
  if (customResolver) {
    return customResolver(cleanA, cleanB);
  }
  if (!rtdb) return false;

  try {
    const [snapByDriverA, snapByApprovedA, snapApprovedA] = await Promise.all([
      rtdb.ref(`drivers/identityBindings/byDriver/${cleanA}`).once('value'),
      rtdb.ref(`drivers/identityBindings/byApproved/${cleanA}`).once('value'),
      rtdb.ref(`drivers/approved/${cleanA}`).once('value'),
    ]);
    if (snapByDriverA.exists() && snapByDriverA.val()?.approvedKey === cleanB) return true;
    if (snapByApprovedA.exists() && snapByApprovedA.val()?.driverId === cleanB) return true;
    if (snapApprovedA.exists() && snapApprovedA.val()?.migratedToDriverId === cleanB) return true;

    const [snapByDriverB, snapByApprovedB, snapApprovedB] = await Promise.all([
      rtdb.ref(`drivers/identityBindings/byDriver/${cleanB}`).once('value'),
      rtdb.ref(`drivers/identityBindings/byApproved/${cleanB}`).once('value'),
      rtdb.ref(`drivers/approved/${cleanB}`).once('value'),
    ]);
    if (snapByDriverB.exists() && snapByDriverB.val()?.approvedKey === cleanA) return true;
    if (snapByApprovedB.exists() && snapByApprovedB.val()?.driverId === cleanA) return true;
    if (snapApprovedB.exists() && snapApprovedB.val()?.migratedToDriverId === cleanA) return true;

    return false;
  } catch (err) {
    console.warn('[pullCorrectionSignal] error resolving driver equivalence:', err);
    return false;
  }
}

/**
 * Checks if targetDriverId matches any candidate from a dispatch.
 */
export async function matchDriverIdentity(
  candidateIds: string[],
  targetDriverId: string,
  rtdb?: admin.database.Database | null,
  customResolver?: (a: string, b: string) => Promise<boolean>,
): Promise<boolean> {
  const target = (targetDriverId || '').trim();
  if (!target || candidateIds.length === 0) return false;

  for (const cand of candidateIds) {
    const cleanCand = cand.trim();
    if (!cleanCand) continue;
    if (cleanCand === target) return true;
  }

  for (const cand of candidateIds) {
    const cleanCand = cand.trim();
    if (!cleanCand) continue;
    if (await areDriverIdentitiesEquivalent(cleanCand, target, rtdb, customResolver)) {
      return true;
    }
  }

  return false;
}

export interface PublishPullCorrectionOptions {
  dispatchIds: string[];
  signal: PullCorrectionSignal;
  rtdb?: admin.database.Database | null;
  driverIdentityResolver?: (idA: string, idB: string) => Promise<boolean>;
  serverTimestamp?: any;
  arrayUnion?: (val: unknown) => any;
}

export interface PublishPullCorrectionResult {
  ok: boolean;
  revision: string;
  updatedDispatchIds: string[];
  skipped?: string;
  results?: Record<string, { ok: boolean; applied?: boolean; reason?: string }>;
}

/**
 * Applies the verified confirmed pull correction signal to target dispatches documents.
 * Verifies company containment (fail-closed), well containment (fail-closed),
 * and driver containment (fail-closed with canonical UUID <-> legacy hash resolution).
 * Enforces idempotency (no-op if revision matches) and monotonic CAS ordering
 * (rejects older out-of-order revisions from overwriting newer ones).
 */
export async function publishPullCorrectionToDispatches(
  firestore: admin.firestore.Firestore,
  options: PublishPullCorrectionOptions,
): Promise<PublishPullCorrectionResult> {
  if (!options.dispatchIds || options.dispatchIds.length === 0) {
    return { ok: false, revision: options.signal.revision, updatedDispatchIds: [], skipped: 'no_dispatch_ids' };
  }

  const patch = buildDispatchCorrectionPatch(options.signal, options.serverTimestamp);
  const updatedDispatchIds: string[] = [];
  const results: Record<string, { ok: boolean; applied?: boolean; reason?: string }> = {};

  for (const did of options.dispatchIds) {
    const docRef = firestore.collection('dispatches').doc(did);

    const evaluateAndUpdate = async (
      data: Record<string, any>,
      updateFn: (dataToUpdate: Record<string, unknown>) => Promise<void>,
    ): Promise<{ ok: boolean; applied?: boolean; reason?: string }> => {
      // 1. Company scoping check (fails closed)
      if (!options.signal.companyId || !docBelongsToTenant(data.companyId, options.signal.companyId)) {
        console.warn(`[pullCorrectionSignal] dispatch ${did} company mismatch: ${data.companyId} !== ${options.signal.companyId}`);
        return { ok: false, reason: 'company_mismatch' };
      }

      // 2. Well scoping check (fails closed)
      const dispWell = data.wellName || data.well;
      if (!dispWell || normalizeWellName(dispWell) !== normalizeWellName(options.signal.wellName)) {
        console.warn(`[pullCorrectionSignal] dispatch ${did} well mismatch or missing: ${dispWell} !== ${options.signal.wellName}`);
        return { ok: false, reason: 'well_mismatch' };
      }

      // 3. Driver scoping check (fails closed + equivalence)
      const candidates = extractDispatchDriverCandidates(data);
      if (candidates.length === 0 || !options.signal.driverId) {
        console.warn(`[pullCorrectionSignal] dispatch ${did} missing driver assignment or signal missing driverId`);
        return { ok: false, reason: 'driver_missing' };
      }
      const isDriverMatch = await matchDriverIdentity(
        candidates,
        options.signal.driverId,
        options.rtdb,
        options.driverIdentityResolver,
      );
      if (!isDriverMatch) {
        console.warn(`[pullCorrectionSignal] dispatch ${did} driver mismatch: ${candidates.join(',')} !== ${options.signal.driverId}`);
        return { ok: false, reason: 'driver_mismatch' };
      }

      // 4. Idempotency check: already at exact revision
      if (data.lastPullRevision === options.signal.revision) {
        return { ok: true, applied: false, reason: 'already_at_revision' };
      }

      // 5. Monotonic ordering / CAS check: prevent out-of-order overwrite
      const existingPublishedMs = Number(data.lastPullCorrection?.publishedAtMs || 0);
      if (existingPublishedMs > 0 && options.signal.publishedAtMs < existingPublishedMs) {
        console.warn(
          `[pullCorrectionSignal] dispatch ${did} has newer revision (${existingPublishedMs} > ${options.signal.publishedAtMs}); skipping out-of-order replay`,
        );
        return { ok: true, applied: false, reason: 'superseded_by_newer_revision' };
      }

      // 6. Apply patch
      const updateData: Record<string, unknown> = { ...patch };
      if (options.arrayUnion) {
        updateData.pullPacketIds = options.arrayUnion(options.signal.packetId);
      }
      await updateFn(updateData);
      return { ok: true, applied: true };
    };

    try {
      let outcome: { ok: boolean; applied?: boolean; reason?: string };
      if (typeof (firestore as any).runTransaction === 'function') {
        outcome = await (firestore as any).runTransaction(async (tx: any) => {
          const docSnap = await tx.get(docRef);
          if (!docSnap.exists) {
            return { ok: false, reason: 'doc_not_found' };
          }
          const data = docSnap.data() || {};
          return await evaluateAndUpdate(data, async (updateData) => {
            tx.update(docRef, updateData);
          });
        });
      } else {
        const docSnap = await docRef.get();
        if (!docSnap.exists) {
          outcome = { ok: false, reason: 'doc_not_found' };
        } else {
          const data = docSnap.data() || {};
          outcome = await evaluateAndUpdate(data, async (updateData) => {
            await docRef.update(updateData);
          });
        }
      }

      results[did] = outcome;
      if (outcome.ok) {
        updatedDispatchIds.push(did);
      }
    } catch (err) {
      console.warn(`[pullCorrectionSignal] error updating dispatch ${did}:`, err);
      results[did] = { ok: false, reason: (err as any)?.message || String(err) };
      throw err;
    }
  }

  return {
    ok: updatedDispatchIds.length > 0,
    revision: options.signal.revision,
    updatedDispatchIds,
    skipped: updatedDispatchIds.length === 0 ? 'all_dispatches_filtered_or_missing' : undefined,
    results,
  };
}

/**
 * Reconciles any pending pull correction signal on a processed packet.
 * Can be called by triggers on retry, watchdog, or explicit admin repair.
 */
export async function reconcilePendingPullCorrectionSignal(
  firestore: admin.firestore.Firestore,
  rtdb: admin.database.Database,
  packetId: string,
  options?: {
    driverIdentityResolver?: (idA: string, idB: string) => Promise<boolean>;
    serverTimestamp?: any;
    arrayUnion?: (val: unknown) => any;
  },
): Promise<{
  ok: boolean;
  status: 'not_pending' | 'reconciled' | 'skipped' | 'failed';
  revision?: string;
  updatedDispatchIds?: string[];
  reason?: string;
}> {
  const pid = String(packetId || '').trim();
  if (!pid) {
    return { ok: false, status: 'failed', reason: 'invalid_packet_id' };
  }

  const snap = await rtdb.ref(`packets/processed/${pid}`).once('value');
  if (!snap.exists()) {
    return { ok: false, status: 'failed', reason: 'packet_not_found' };
  }
  const pkt = snap.val() || {};

  const committedRev = pkt.outgoingCommittedRevision || pkt.lastPullRevision;
  const deliveredRev = pkt.lastPullDeliveredRevision;
  const isPending =
    pkt.dispatchSignalPending === true ||
    (committedRev && committedRev !== deliveredRev);

  if (!isPending) {
    return { ok: true, status: 'not_pending', revision: deliveredRev };
  }

  const bottom = pkt.tankAfterFeet || pkt.currentLevel || pkt.lastPullBottomLevel || '';
  const time = pkt.dateTimeUTC || pkt.lastPullDateTimeUTC || '';
  const flow = pkt.flowRate || '';
  const wellName = pkt.wellName || '';
  const companyId = pkt.companyId || 'liquid-gold';
  const driverId = pkt.driverId || null;

  const revision = committedRev || computePullRevision(pid, bottom, time, flow);

  const signal: PullCorrectionSignal = {
    packetId: pid,
    revision,
    bottomLevel: bottom,
    pullDateTimeUTC: time,
    flowRate: flow,
    publishedAtMs: Date.now(),
    wellName,
    companyId,
    driverId,
  };

  const dispatchIds = await findDispatchIdsForPull(firestore, {
    dispatchId: pkt.dispatchId,
    packetId: pid,
    companyId,
    wellName,
    driverId,
  });

  if (dispatchIds.length === 0) {
    await rtdb.ref(`packets/processed/${pid}`).update({
      lastPullDeliveredRevision: revision,
      lastPullRevision: revision,
      dispatchSignalPending: null,
      dispatchSignalPendingRevision: null,
      dispatchSignalError: null,
    });
    return { ok: true, status: 'skipped', revision, reason: 'no_target_dispatches' };
  }

  try {
    const pubResult = await publishPullCorrectionToDispatches(firestore, {
      dispatchIds,
      signal,
      rtdb,
      driverIdentityResolver: options?.driverIdentityResolver,
      serverTimestamp: options?.serverTimestamp,
      arrayUnion: options?.arrayUnion,
    });

    if (pubResult.ok) {
      await rtdb.ref(`packets/processed/${pid}`).update({
        lastPullDeliveredRevision: revision,
        lastPullRevision: revision,
        dispatchSignalPending: null,
        dispatchSignalPendingRevision: null,
        dispatchSignalError: null,
      });
      return {
        ok: true,
        status: 'reconciled',
        revision,
        updatedDispatchIds: pubResult.updatedDispatchIds,
      };
    } else {
      await rtdb.ref(`packets/processed/${pid}`).update({
        lastPullDeliveredRevision: revision,
        lastPullRevision: revision,
        dispatchSignalPending: null,
        dispatchSignalPendingRevision: null,
        dispatchSignalError: 'all_dispatches_filtered_or_missing',
      });
      return {
        ok: true,
        status: 'skipped',
        revision,
        reason: 'all_dispatches_filtered_or_missing',
      };
    }
  } catch (err) {
    const errMsg = (err as any)?.message || String(err);
    await rtdb.ref(`packets/processed/${pid}`).update({
      dispatchSignalPending: true,
      dispatchSignalPendingRevision: revision,
      dispatchSignalError: errMsg,
    });
    return { ok: false, status: 'failed', revision, reason: errMsg };
  }
}
