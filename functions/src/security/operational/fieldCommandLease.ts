/**
 * Receipt lease / idempotency / exclusive target lock for submitFieldCommand.
 *
 * Receipt key is company+type+targetPacket+contentDigest.
 * Target lock key is company+targetPacketId only — independent of
 * edit/delete type and of content digest.
 *
 * Every invocation carries a unique attempt token and a monotonic
 * fencing generation. Lease exceeds the callable timeout with margin.
 */
import { createHash, randomUUID } from 'crypto';

export type LeaseStatus = 'leased' | 'applied' | 'committed' | 'recoverable';

/** Callable timeout is 30s. Lease must outlive that with margin. */
export const FIELD_COMMAND_FUNCTION_TIMEOUT_MS = 30_000;
export const FIELD_COMMAND_LEASE_MS = 90_000;

export interface FieldReceipt {
  exists: boolean;
  driverId?: string;
  companyId?: string;
  type?: string;
  targetPacketId?: string;
  digest?: string;
  status?: LeaseStatus;
  leaseOwner?: string;
  leaseUntil?: number;
  attemptToken?: string;
  fenceGeneration?: number;
  applied?: boolean;
  versionIncremented?: boolean;
  markersPublished?: boolean;
  outgoingId?: string | null;
  wellDown?: boolean;
  doneEffects?: Record<string, true>;
  healCode?: string;
}

export interface FenceOwner {
  attemptToken: string;
  fenceGeneration: number;
}

export interface TargetLock {
  exists: boolean;
  attemptToken?: string;
  fenceGeneration?: number;
  receiptKey?: string;
  leaseUntil?: number;
  ownerDriverId?: string;
}

export function newAttemptToken(): string {
  return randomUUID();
}

export function canonicalReceiptKey(input: {
  companyId: string;
  type: string;
  targetPacketId: string;
  digest: string;
}): string {
  const raw = [input.companyId, input.type, input.targetPacketId, input.digest].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

export const DIGEST_FIELDS = Object.freeze([
  'type',
  'targetPacketId',
  'wellName',
  'tankLevelFeet',
  'bblsTaken',
  'dateTimeUTC',
  'dateTime',
  'timezone',
  'wellDown',
  'predictedLevelInches',
  'invoiceDocId',
  'dispatchId',
  'jobType',
  'jobOrigin',
  'invoicingMode',
  'originAppContext',
] as const);

export function contentDigest(fields: Record<string, unknown>): string {
  const stable = DIGEST_FIELDS.map((k) => `${k}=${JSON.stringify(fields[k] ?? null)}`).join('&');
  return createHash('sha256').update(stable).digest('hex');
}

export function decideLease(
  existing: FieldReceipt,
  intended: {
    driverId: string;
    companyId: string;
    type: string;
    targetPacketId: string;
    digest: string;
    nowMs: number;
  },
):
  | { action: 'create' }
  | { action: 'resume' }
  | { action: 'duplicate' }
  | { action: 'collision' } {
  if (!existing.exists) return { action: 'create' };
  const sameOp =
    existing.driverId === intended.driverId &&
    existing.companyId === intended.companyId &&
    existing.type === intended.type &&
    existing.targetPacketId === intended.targetPacketId &&
    existing.digest === intended.digest;
  if (!sameOp) return { action: 'collision' };
  // Committed without markers is NOT a duplicate — crash after commit
  // must resume so markers_only can run. Only fully published receipts
  // short-circuit.
  if (existing.status === 'committed' && existing.markersPublished === true) {
    return { action: 'duplicate' };
  }
  if (existing.status === 'committed') return { action: 'resume' };
  // A live *leased* receipt is exclusive, including the same driver.
  // Applied/recoverable receipts resume so crash recovery can finish
  // increment/commit. Concurrent apply is fenced by the target lock.
  const leaseLive =
    existing.status === 'leased' &&
    typeof existing.leaseUntil === 'number' &&
    existing.leaseUntil > intended.nowMs;
  if (leaseLive) return { action: 'collision' };
  return { action: 'resume' };
}

export type LeaseApplyPlan =
  | 'apply'
  | 'increment_only'
  | 'mark_version'
  | 'commit_only'
  | 'markers_only'
  | 'duplicate';

/** Crash-boundary plan after the exclusive lease is held. Reconstructs from receipt only. */
export function nextLeaseApplyPlan(receipt: FieldReceipt): LeaseApplyPlan {
  if (receipt.status === 'committed' && receipt.markersPublished) return 'duplicate';
  if (receipt.status === 'committed') return 'markers_only';
  if (receipt.status === 'applied' && receipt.versionIncremented) return 'commit_only';
  if (receipt.status === 'applied') return 'increment_only';
  // recoverable is a non-committed saga state: retry apply from doneEffects
  return 'apply';
}

export function decideVersionAck(existingAck: unknown): { writeAck: boolean; increment: boolean } {
  if (existingAck) return { writeAck: false, increment: false };
  return { writeAck: true, increment: true };
}

/**
 * One lock per company + original packet. Edit and delete of the same
 * original share this key. Content digest is intentionally excluded.
 */
export function targetLockKey(input: { companyId: string; targetPacketId: string }): string {
  return createHash('sha256').update([input.companyId, input.targetPacketId].join('|')).digest('hex');
}

export function nextFenceGeneration(existing: TargetLock): number {
  const g = existing.fenceGeneration;
  return typeof g === 'number' && Number.isFinite(g) && g >= 0 ? g + 1 : 1;
}

export function decideTargetLock(
  existing: TargetLock,
  intended: { attemptToken: string; nowMs: number; receiptKey?: string; resumeSameReceipt?: boolean },
): 'acquire' | 'reacquire_same' | 'collision' {
  if (!existing.exists) return 'acquire';
  const live =
    typeof existing.leaseUntil === 'number' && existing.leaseUntil > intended.nowMs;
  if (!live) return 'acquire';
  if (existing.attemptToken && existing.attemptToken === intended.attemptToken) {
    return 'reacquire_same';
  }
  // Same-receipt retry may acquire only after the live lease expires.
  // Stealing a live lock would let two pipelines publish effects.
  if (
    intended.resumeSameReceipt &&
    intended.receiptKey &&
    existing.receiptKey === intended.receiptKey &&
    !live
  ) {
    return 'acquire';
  }
  return 'collision';
}

export function generationNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function decideMarkerWrite(
  existingGeneration: unknown,
  incomingGeneration: number,
): 'write' | 'skip' | 'stale' {
  const g = generationNumber(existingGeneration);
  if (incomingGeneration < g) return 'stale';
  if (incomingGeneration === g && g > 0) return 'skip';
  return 'write';
}

/**
 * Atomic companion-aware marker decision.
 *
 * Equal generation is idempotent for already-complete markers but must
 * still heal a missing outgoing companion. A lower generation never
 * overwrites a higher one.
 */
export function decideAtomicMarkerWrite(input: {
  processedGeneration: unknown;
  outgoingGeneration?: unknown;
  incomingGeneration: number;
  outgoingRequired: boolean;
  outgoingPresent: boolean;
}): 'write' | 'heal_outgoing' | 'skip' | 'stale' {
  const processed = generationNumber(input.processedGeneration);
  const outgoing = generationNumber(input.outgoingGeneration);
  if (input.incomingGeneration < processed) return 'stale';
  if (input.incomingGeneration < outgoing) return 'stale';
  if (input.incomingGeneration > processed) return 'write';
  if (input.incomingGeneration === processed && processed > 0) {
    if (input.outgoingRequired && (!input.outgoingPresent || outgoing < processed)) {
      return 'heal_outgoing';
    }
    return 'skip';
  }
  return 'write';
}

export function verifyFence(
  lock: TargetLock,
  owned: FenceOwner & { nowMs: number },
): boolean {
  if (!lock.exists) return false;
  if (lock.attemptToken !== owned.attemptToken) return false;
  if (lock.fenceGeneration !== owned.fenceGeneration) return false;
  if (typeof lock.leaseUntil !== 'number' || lock.leaseUntil <= owned.nowMs) return false;
  return true;
}

export function decideReleaseLock(
  lock: TargetLock,
  owned: FenceOwner,
): 'delete' | 'refuse' | 'noop' {
  if (!lock.exists) return 'noop';
  if (lock.attemptToken !== owned.attemptToken) return 'refuse';
  if (lock.fenceGeneration !== owned.fenceGeneration) return 'refuse';
  return 'delete';
}
