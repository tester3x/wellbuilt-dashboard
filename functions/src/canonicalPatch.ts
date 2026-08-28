// canonicalPatch.ts — assemble ONE atomic multi-location update for a canonical
// mutation from the pure builder outputs. This is the single place that composes
// processed rows + outgoing/current + well status + performance + production +
// AFR/config + chronology fence + the completion receipt into one all-or-nothing
// patch. The coordinator (runCanonicalMutation) submits exactly this map; a
// failure exposes none of it. The receipt is part of the SAME patch.
import type { CommitReceipt } from './chronoCommitCoordinator';

/**
 * The EXACT set of `wells/<well>/status` child keys OWNED by a canonical mutation.
 * A status commit writes each of these (new value when present in the status
 * object, else `null` so an obsolete canonical child cannot linger forever) and
 * NOTHING else under status. Coordinator-owned metadata (`chronoLock`,
 * `chronoRevision`) and any unrelated/non-canonical child are deliberately left
 * untouched. Keep this in lockstep with buildWellStatus / the edit status object.
 */
export const CANONICAL_STATUS_KEYS = [
  'wellName', 'config', 'current', 'lastPull', 'calculated', 'isDown', 'updatedAt',
] as const;

/** Never written from the status object — the coordinator owns these under status. */
const COORDINATOR_STATUS_KEYS = new Set(['chronoLock', 'chronoRevision']);

export interface CanonicalPatchPieces {
  /** packets/processed/<id>/<field> updates for the mutated + changed neighbor
   *  rows (from the chrono engine / planBackdatedCommit). */
  processedUpdates: Record<string, unknown>;
  /** Outgoing/current: delete the well's prior response ids, and (unless a delete
   *  cleared the last pull) write the new one. Omit responseId/response to clear
   *  outgoing without writing a replacement. */
  outgoing?: { deleteResponseIds: string[]; responseId?: string; response?: Record<string, unknown> } | null;
  /** wells/<well>/status object. */
  wellStatus?: { wellName: string; status: Record<string, unknown> } | null;
  /** performance/<wellKey>/rows/<ts> row + wellName + updated. */
  performance?: { wellKey: string; perfTimestamp: string; row: Record<string, unknown>; wellName: string; updatedIso: string } | null;
  /** production/<wellKey>/<date> value(s) — pass one entry per AFFECTED date
   *  (an edit crossing dates supplies both the removed-old and added-new dates). */
  production?: Array<{ wellKey: string; date: string; value: Record<string, unknown> | null }>;
  /** well_config AFR rolling values. */
  afr?: { wellName: string; avgFlowRate: string; avgFlowRateMinutes: number } | null;
  /** wells/<well>/status/chronoRevision monotonic bump. */
  fence?: { wellName: string; revision: number } | null;
  /** Completion receipt — written in the SAME atomic update, at receiptPath. */
  receipt: CommitReceipt;
  receiptPath: string;
}

export function assembleCanonicalPatch(p: CanonicalPatchPieces): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...p.processedUpdates };

  if (p.outgoing) {
    for (const id of p.outgoing.deleteResponseIds) patch[`packets/outgoing/${id}`] = null;
    // A delete that removed the last pull clears outgoing with no replacement.
    if (p.outgoing.responseId) patch[`packets/outgoing/${p.outgoing.responseId}`] = p.outgoing.response ?? null;
  }
  if (p.wellStatus) {
    // Write status as OWNED child-key paths — never a full-node set of
    // wells/<well>/status. A full-node set would (1) collide with the
    // status/chronoRevision child path below (Firebase update() rejects
    // overlapping locations) and (2) wipe the coordinator's live status/chronoLock
    // mid-commit. Explicit replacement semantics: every value the mutation
    // produced is written (except coordinator-owned metadata), AND every OWNED key
    // the new status omits is nulled so an obsolete canonical child cannot linger.
    // Unrelated/non-canonical children (and chronoLock/chronoRevision) are left
    // untouched.
    const well = p.wellStatus.wellName;
    const status = p.wellStatus.status;
    for (const [k, v] of Object.entries(status)) {
      if (COORDINATOR_STATUS_KEYS.has(k)) continue; // never let status carry these
      patch[`wells/${well}/status/${k}`] = v;
    }
    for (const k of CANONICAL_STATUS_KEYS) {
      if (!(k in status)) patch[`wells/${well}/status/${k}`] = null; // remove stale owned child
    }
  }
  if (p.performance) {
    patch[`performance/${p.performance.wellKey}/rows/${p.performance.perfTimestamp}`] = p.performance.row;
    patch[`performance/${p.performance.wellKey}/wellName`] = p.performance.wellName;
    patch[`performance/${p.performance.wellKey}/updated`] = p.performance.updatedIso;
  }
  for (const prod of p.production ?? []) {
    patch[`production/${prod.wellKey}/${prod.date}`] = prod.value; // null removes a vacated date
  }
  if (p.afr) {
    patch[`well_config/${p.afr.wellName}/avgFlowRate`] = p.afr.avgFlowRate;
    patch[`well_config/${p.afr.wellName}/avgFlowRateMinutes`] = p.afr.avgFlowRateMinutes;
  }
  if (p.fence) {
    patch[`wells/${p.fence.wellName}/status/chronoRevision`] = p.fence.revision;
  }
  // The completion receipt lands in the SAME atomic update.
  patch[p.receiptPath] = p.receipt;
  return patch;
}

/** The canonical receipt location (keyed by operation id) — read by recovery and
 *  by the idempotency short-circuit. */
export function receiptPathFor(wellName: string, operationId: string): string {
  return `wells/${wellName}/chronoReceipts/${operationId}`;
}
