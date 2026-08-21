/**
 * Durable field-command pipeline. Crash recovery reconstructs exclusively
 * from persisted Firestore/RTDB — never from exception-carried maps.
 *
 * Crash points (after the named statement, before the next):
 *   after_mutation_before_effect_persist
 *   after_effect_<name>
 *   after_final_effect_before_applied
 *   after_applied_before_version
 *   after_version_before_versionIncremented
 *   after_versionIncremented_before_committed
 *   after_committed_before_markers
 *   after_committed_before_response
 */
import type { FieldApplyStores, FieldEffectName } from './fieldCommandApply';
import { applyFieldCommandMutation, publishCommittedEditMarkers } from './fieldCommandApply';
import {
  FIELD_COMMAND_LEASE_MS,
  nextLeaseApplyPlan,
  type FenceOwner,
  type FieldReceipt,
} from './fieldCommandLease';
import {
  acquireExclusiveTargetLock,
  persistDoneEffectNested,
  readDoneEffects,
  releaseTargetLockIfOwner,
  transitionReceiptAtomic,
  type PersistTxn,
} from './fieldCommandPersist';
import type { SecureDriver } from '../requireDriverAuth';

export type FieldCrashPoint =
  | 'after_mutation_before_effect_persist'
  | `after_effect_${FieldEffectName}`
  | 'after_final_effect_before_applied'
  | 'after_applied_before_version'
  | 'after_version_before_versionIncremented'
  | 'after_versionIncremented_before_committed'
  | 'after_committed_before_markers'
  | 'after_committed_before_response';

export class FieldPipelineInterrupt extends Error {
  constructor(public readonly at: FieldCrashPoint) {
    super(`crash_${at}`);
    this.name = 'FieldPipelineInterrupt';
  }
}

export interface OrchestratorPaths {
  receiptPath: string;
  lockPath: string;
}

export interface FieldPipelineInput {
  type: 'pull' | 'edit' | 'delete';
  packetId: string;
  originalPacketId?: string;
  stamped: Record<string, unknown>;
  driver: SecureDriver;
  manager: boolean;
  receiptKey: string;
  attemptToken: string;
  nowMs?: number;
  nowFn?: () => number;
  crashAt?: FieldCrashPoint;
}

export interface FieldPipelineResult {
  ok: true;
  duplicate?: boolean;
  recoverable?: boolean;
  healCode?: string;
  committed: boolean;
  outgoingId: string | null;
  targetPacketId: string;
  wellDown: boolean;
  fence?: FenceOwner;
}

function crash(at: FieldCrashPoint, wanted?: FieldCrashPoint): void {
  if (wanted && wanted === at) throw new FieldPipelineInterrupt(at);
}

export async function runFieldCommandPipeline(
  stores: FieldApplyStores,
  txn: PersistTxn,
  paths: OrchestratorPaths,
  input: FieldPipelineInput,
): Promise<FieldPipelineResult> {
  const receipt = ((await txn.get(paths.receiptPath)) || {}) as FieldReceipt & Record<string, unknown>;
  const plan = nextLeaseApplyPlan({
    exists: true,
    status: (receipt.status as FieldReceipt['status']) || 'leased',
    versionIncremented: receipt.versionIncremented === true,
    markersPublished: receipt.markersPublished === true,
  });

  if (plan === 'duplicate') {
    return {
      ok: true,
      duplicate: true,
      committed: true,
      outgoingId: (receipt.outgoingId as string | null) || null,
      targetPacketId: String(receipt.targetPacketId || input.originalPacketId || input.packetId),
      wellDown: receipt.wellDown === true,
    };
  }

  const clock = input.nowFn
    || (typeof input.nowMs === 'number' ? () => input.nowMs as number : () => Date.now());
  const resumeSameReceipt =
    receipt.status === 'applied' ||
    receipt.status === 'committed' ||
    receipt.status === 'recoverable';
  const fence = await acquireExclusiveTargetLock(txn, paths.lockPath, {
    attemptToken: input.attemptToken,
    nowMs: clock(),
    leaseMs: FIELD_COMMAND_LEASE_MS,
    receiptKey: input.receiptKey,
    ownerDriverId: input.driver.driverId,
    companyId: input.driver.companyId,
    targetPacketId: String(input.originalPacketId || input.packetId),
    resumeSameReceipt,
  });

  const persistNamed = async (name: FieldEffectName) => {
    if (input.crashAt === 'after_mutation_before_effect_persist') {
      throw new FieldPipelineInterrupt('after_mutation_before_effect_persist');
    }
    await persistDoneEffectNested(
      txn,
      paths.receiptPath,
      paths.lockPath,
      fence,
      name,
      clock(),
    );
    crash(`after_effect_${name}`, input.crashAt);
  };

  stores.persistEffect = persistNamed;

  let applied: {
    outgoingId: string | null;
    targetPacketId: string;
    wellDown: boolean;
  } = {
    outgoingId: (receipt.outgoingId as string | null) || null,
    targetPacketId: String(input.originalPacketId || input.packetId),
    wellDown: receipt.wellDown === true,
  };

  if (plan === 'apply') {
    const persisted = readDoneEffects(receipt as Record<string, unknown>);
    try {
      const result = await applyFieldCommandMutation(stores, {
        type: input.type,
        packetId: input.packetId,
        originalPacketId: input.originalPacketId,
        stamped: input.stamped,
        driver: input.driver,
        manager: input.manager,
        skipVersionIncrement: true,
        doneEffects: persisted,
      });
      applied = {
        outgoingId: result.outgoingId,
        targetPacketId: result.targetPacketId,
        wellDown: result.wellDown,
      };
    } catch (err) {
      const code = (err as { code?: string }).code || (err as Error).message;
      if (
        code === 'linked_missing' ||
        code === 'linked_mismatch' ||
        code === 'linked_unavailable' ||
        code === 'stale_fence'
      ) {
        await transitionReceiptAtomic(txn, paths.receiptPath, paths.lockPath, fence, {
          status: 'recoverable',
          healCode: code,
          outgoingId: applied.outgoingId,
          wellDown: applied.wellDown,
        }, clock());
        return {
          ok: true,
          recoverable: true,
          committed: false,
          healCode: String(code),
          outgoingId: applied.outgoingId,
          targetPacketId: applied.targetPacketId,
          wellDown: applied.wellDown,
          fence,
        };
      }
      throw err;
    }
    crash('after_final_effect_before_applied', input.crashAt);
    await transitionReceiptAtomic(txn, paths.receiptPath, paths.lockPath, fence, {
      status: 'applied',
      outgoingId: applied.outgoingId,
      targetPacketId: applied.targetPacketId,
      wellDown: applied.wellDown,
      appliedAt: clock(),
    }, clock());
  }

  if (plan === 'apply' || plan === 'increment_only') {
    crash('after_applied_before_version', input.crashAt);
    if (typeof stores.incrementIncomingVersionOnce === 'function') {
      await stores.incrementIncomingVersionOnce(input.receiptKey);
    } else {
      await stores.incrementIncomingVersion();
    }
    crash('after_version_before_versionIncremented', input.crashAt);
    await transitionReceiptAtomic(txn, paths.receiptPath, paths.lockPath, fence, {
      versionIncremented: true,
    }, clock());
  }

  if (plan === 'apply' || plan === 'increment_only' || plan === 'commit_only') {
    crash('after_versionIncremented_before_committed', input.crashAt);
    await transitionReceiptAtomic(txn, paths.receiptPath, paths.lockPath, fence, {
      status: 'committed',
      committedAt: clock(),
    }, clock());
  }

  const afterCommit = (await txn.get(paths.receiptPath)) || {};
  if (afterCommit.markersPublished !== true && (input.type === 'edit' || input.type === 'delete')) {
    crash('after_committed_before_markers', input.crashAt);
    if (input.type === 'edit') {
      const published = await publishCommittedEditMarkers(stores, {
        targetId: applied.targetPacketId,
        receiptKey: input.receiptKey,
        fenceGeneration: fence.fenceGeneration,
        driverId: input.driver.driverId,
        outgoingId: applied.outgoingId,
      });
      if (!published.complete) {
        throw Object.assign(new Error(published.reason || 'markers_incomplete'), {
          code: published.reason === 'stale' ? 'stale_fence' : 'markers_incomplete',
        });
      }
    }
    await transitionReceiptAtomic(txn, paths.receiptPath, paths.lockPath, fence, {
      markersPublished: true,
    }, clock());
  }

  crash('after_committed_before_response', input.crashAt);
  await releaseTargetLockIfOwner(txn, paths.lockPath, fence);

  return {
    ok: true,
    committed: true,
    outgoingId: applied.outgoingId,
    targetPacketId: applied.targetPacketId,
    wellDown: applied.wellDown,
    fence,
  };
}
