// mutationBuilders.ts — compose the verified pure pieces (chrono engine, formula
// builders, atomic assembler) into ONE {patch, receipt} per mutation type. These
// are pure/injected and land FIRST (green-throughout) while the legacy handlers
// stay live; the trigger swap (step 3) makes the handlers call these + the
// coordinator. Each builder produces exactly one canonical multipath update
// (via assembleCanonicalPatch) whose receipt is part of the same patch.
import {
  recomputeWell, upsertPull, currentPull, planBackdatedCommit,
  type ChronoPullInput, type WellChronoConfig, type ChronoPullResult,
} from './chronoRecompute';
import { assembleCanonicalPatch, receiptPathFor, type CanonicalPatchPieces } from './canonicalPatch';
import type { CommitReceipt } from './chronoCommitCoordinator';

/** Canonical objects the caller pre-builds from the verified builders
 *  (buildOutgoingResponse / buildWellStatus / buildPerformanceRow / production /
 *  AFR). mutationBuilders compose them with the engine's processed diff + the
 *  receipt into one atomic patch. */
export interface CanonicalSidecar {
  outgoing?: CanonicalPatchPieces['outgoing'];
  wellStatus?: CanonicalPatchPieces['wellStatus'];
  performance?: CanonicalPatchPieces['performance'];
  production?: CanonicalPatchPieces['production'];
  afr?: CanonicalPatchPieces['afr'];
}

export interface MutationCommon {
  wellName: string;
  operationId: string;
  fence: number;
  revision: number;
  committedAtMs: number;
  /** Stable per-mutation identity/version hash for the receipt. */
  patchHash: string;
  sidecar: CanonicalSidecar;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Derived-field updates for one processed row (the mutated row or a changed
 *  successor), including the chronology fence + review tags. */
function derivedRowUpdates(base: string, r: ChronoPullResult, fence: number): Record<string, unknown> {
  return {
    [`${base}/tankAfterInches`]: round(r.tankAfterInches),
    [`${base}/recoveryInches`]: round(r.recoveryInches),
    [`${base}/timeDifDays`]: round(r.timeDifDays),
    [`${base}/flowRateDays`]: round(r.flowRateDays),
    [`${base}/lateEntry`]: r.lateEntry,
    [`${base}/anomaly`]: r.anomaly,
    [`${base}/anomalyReasons`]: r.anomalyReasons,
    [`${base}/potentialDuplicate`]: r.potentialDuplicate,
    [`${base}/needsReview`]: r.needsReview,
    [`${base}/chronoRevision`]: fence,
  };
}

function makeReceipt(c: MutationCommon, mutationType: CommitReceipt['mutationType'], affectedPacketIds: string[]): CommitReceipt {
  return {
    operationId: c.operationId, mutationType, wellName: c.wellName,
    fence: c.fence, revision: c.revision, affectedPacketIds,
    committedAtMs: c.committedAtMs, patchHash: c.patchHash,
  };
}

function assemble(c: MutationCommon, processedUpdates: Record<string, unknown>, receipt: CommitReceipt): { patch: Record<string, unknown>; receipt: CommitReceipt } {
  const patch = assembleCanonicalPatch({
    processedUpdates,
    outgoing: c.sidecar.outgoing ?? null,
    wellStatus: c.sidecar.wellStatus ?? null,
    performance: c.sidecar.performance ?? null,
    production: c.sidecar.production ?? [],
    afr: c.sidecar.afr ?? null,
    fence: { wellName: c.wellName, revision: c.fence },
    receipt,
    receiptPath: receiptPathFor(c.wellName, c.operationId),
  });
  return { patch, receipt };
}

// ── CREATE (newest OR backdated) ───────────────────────────────────────────
export interface CreateMutationInput extends MutationCommon {
  existingChain: ChronoPullInput[];
  newPull: ChronoPullInput;
  /** The FULL processed record for the new row (material + computed + processedAt),
   *  built by the caller; derived tags/fence are overlaid here. */
  newProcessedRecord: Record<string, unknown>;
  cfg: WellChronoConfig;
}

export function buildCreateMutation(i: CreateMutationInput): { patch: Record<string, unknown>; receipt: CommitReceipt; isCurrent: boolean } {
  const before = recomputeWell(i.existingChain, i.cfg);
  const after = recomputeWell(upsertPull(i.existingChain, i.newPull), i.cfg);
  const plan = planBackdatedCommit({ before, after, newPacketId: i.newPull.packetId, wellRevision: i.fence });

  const newRow = after.find((r) => r.packetId === i.newPull.packetId)!;
  const current = currentPull(after);
  const isCurrent = current?.packetId === i.newPull.packetId;

  const processedUpdates: Record<string, unknown> = {};
  // Full new record (its own path) — one nested object, so its derived fields go
  // in the record itself (NOT as sibling child-paths, to avoid path conflicts).
  processedUpdates[`packets/processed/${i.newPull.packetId}`] = {
    ...i.newProcessedRecord,
    tankAfterInches: round(newRow.tankAfterInches),
    recoveryInches: round(newRow.recoveryInches),
    timeDifDays: round(newRow.timeDifDays),
    flowRateDays: round(newRow.flowRateDays),
    lateEntry: newRow.lateEntry,
    anomaly: newRow.anomaly,
    anomalyReasons: newRow.anomalyReasons,
    potentialDuplicate: newRow.potentialDuplicate,
    needsReview: newRow.needsReview,
    chronoRevision: i.fence,
  };
  // Changed successors → child-path derived updates only.
  for (const id of plan.changedPacketIds) {
    const r = after.find((x) => x.packetId === id)!;
    Object.assign(processedUpdates, derivedRowUpdates(`packets/processed/${id}`, r, i.fence));
  }

  const affected = [i.newPull.packetId, ...plan.changedPacketIds];
  const receipt = makeReceipt(i, isCurrent ? 'create' : 'backdated_create', affected);
  return { ...assemble(i, processedUpdates, receipt), isCurrent };
}

// ── EDIT (move earlier/later, promote or stay historical) ──────────────────
export interface EditMutationInput extends MutationCommon {
  existingChain: ChronoPullInput[];
  /** The edited pull's new values (same packetId, changed time/level/bbls/down). */
  editedPull: ChronoPullInput;
  cfg: WellChronoConfig;
}

export function buildEditMutation(i: EditMutationInput): { patch: Record<string, unknown>; receipt: CommitReceipt; current: string | null } {
  const before = recomputeWell(i.existingChain, i.cfg);
  const after = recomputeWell(upsertPull(i.existingChain, i.editedPull), i.cfg);

  // Every row whose derived fields changed (both the vacated neighbor and the
  // inserted-position neighbors + the edited row itself) is rewritten.
  const beforeById = new Map(before.map((r) => [r.packetId, r]));
  const processedUpdates: Record<string, unknown> = {};
  const changed: string[] = [];
  const DERIVED = ['tankAfterInches', 'recoveryInches', 'timeDifDays', 'flowRateDays', 'lateEntry', 'anomaly', 'anomalyReasons', 'potentialDuplicate', 'needsReview', 'prevPacketId'] as const;
  for (const r of after) {
    const prev = beforeById.get(r.packetId);
    const isEdited = r.packetId === i.editedPull.packetId;
    const dirty = isEdited || !prev || DERIVED.some((k) => JSON.stringify((r as unknown as Record<string, unknown>)[k]) !== JSON.stringify((prev as unknown as Record<string, unknown>)[k]));
    if (!dirty) continue;
    changed.push(r.packetId);
    Object.assign(processedUpdates, derivedRowUpdates(`packets/processed/${r.packetId}`, r, i.fence));
    if (isEdited) {
      // The edit's own material change (top/bbls/time/down) is applied too.
      const b = `packets/processed/${r.packetId}`;
      processedUpdates[`${b}/tankTopInches`] = round(r.tankTopInches);
      processedUpdates[`${b}/tankLevelFeet`] = r.tankTopInches / 12;
      processedUpdates[`${b}/bblsTaken`] = r.bblsTaken;
      processedUpdates[`${b}/dateTimeUTC`] = r.dateTimeUTC;
      if (typeof r.wellDown === 'boolean') processedUpdates[`${b}/wellDown`] = r.wellDown;
    }
  }
  const current = currentPull(after)?.packetId ?? null;
  const receipt = makeReceipt(i, 'edit', changed);
  return { ...assemble(i, processedUpdates, receipt), current };
}

// ── DELETE (remove a row, repair successor, recompute) ─────────────────────
export interface DeleteMutationInput extends MutationCommon {
  existingChain: ChronoPullInput[];
  deletePacketId: string;
  cfg: WellChronoConfig;
}

export function buildDeleteMutation(i: DeleteMutationInput): { patch: Record<string, unknown>; receipt: CommitReceipt; current: string | null } {
  const before = recomputeWell(i.existingChain, i.cfg);
  const remaining = i.existingChain.filter((p) => p.packetId !== i.deletePacketId);
  const after = recomputeWell(remaining, i.cfg);

  const beforeById = new Map(before.map((r) => [r.packetId, r]));
  const processedUpdates: Record<string, unknown> = {};
  const changed: string[] = [];
  // Remove the deleted row.
  processedUpdates[`packets/processed/${i.deletePacketId}`] = null;
  // Rewrite successors whose derived relationships changed (predecessor moved).
  const DERIVED = ['tankAfterInches', 'recoveryInches', 'timeDifDays', 'flowRateDays', 'lateEntry', 'anomaly', 'anomalyReasons', 'potentialDuplicate', 'needsReview', 'prevPacketId'] as const;
  for (const r of after) {
    const prev = beforeById.get(r.packetId);
    if (prev && !DERIVED.some((k) => JSON.stringify((r as unknown as Record<string, unknown>)[k]) !== JSON.stringify((prev as unknown as Record<string, unknown>)[k]))) continue;
    changed.push(r.packetId);
    Object.assign(processedUpdates, derivedRowUpdates(`packets/processed/${r.packetId}`, r, i.fence));
  }
  const current = currentPull(after)?.packetId ?? null;
  const receipt = makeReceipt(i, 'delete', [i.deletePacketId, ...changed]);
  return { ...assemble(i, processedUpdates, receipt), current };
}
