// processBackdatedPull.ts — accept a VALID older CREATE (guard verdict
// 'process_backdated'): insert it into chronological history, recompute every
// affected successor, tag Late Entry/anomaly, and commit atomically under a
// per-well revision fence — WITHOUT regressing the current/outgoing watermark.
//
// The orchestrator is injected (BackdatedIO) so it unit-tests without an
// emulator; index.ts supplies the real RTDB reader/committer. All effects land
// in ONE atomic multi-location update guarded by the well's chronoRevision, so a
// concurrent newer pull (a stale worker) cannot be overwritten and a failed
// recomputation cannot half-commit.

import {
  recomputeWell, upsertPull, planBackdatedCommit,
  type ChronoPullInput, type WellChronoConfig,
} from './chronoRecompute';

export interface BackdatedIO {
  /** EXCLUSIVE per-well serialization. Runs `fn` only while holding the well's
   *  lock; a concurrent caller cannot enter until the holder releases (or the
   *  lease expires on crash). Returns 'contended' without running `fn` when the
   *  lock is held. This — not a check-then-update revision claim — is what makes
   *  the read→compute→commit sequence atomic against other writers: no second
   *  worker can interleave between another's plan and its commit. Every writer
   *  that mutates chronology/current MUST route through the same lock. */
  withWellLock<T>(wellName: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
  /** All of the well's processed pulls as engine inputs (read under the lock). */
  loadWellPulls(wellName: string): Promise<ChronoPullInput[]>;
  /** Current per-well chronological revision (read under the lock). */
  readWellRevision(wellName: string): Promise<number>;
  /** One atomic multi-location update — safe because it runs while the caller
   *  holds the exclusive well lock, so no interleaving commit exists. */
  commit(updates: Record<string, unknown>): Promise<void>;
}

export type BackdatedOutcome =
  | { status: 'inserted'; changedPacketIds: string[]; lateEntry: boolean; current: string | null; revision: number }
  | { status: 'duplicate_noop' }
  | { status: 'lock_contended' };

/** Immutable material fields written for the NEW row (as child-key updates so the
 *  whole record is created within the single atomic commit). */
function newRowChildUpdates(base: string, data: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  const carry = ['packetId', 'wellName', 'dateTimeUTC', 'dateTime', 'tankLevelFeet', 'bblsTaken',
    'wellDown', 'driverId', 'driverName', 'companyId', 'timezone', 'requestType', 'idempotencyKey',
    'recoveredFromPacketId', 'predictedLevelInches'] as const;
  const out: Record<string, unknown> = {};
  for (const k of carry) if (data[k] !== undefined && data[k] !== null) out[`${base}/${k}`] = data[k];
  out[`${base}/processedAt`] = nowIso;
  out[`${base}/requestType`] = out[`${base}/requestType`] ?? 'pull';
  return out;
}

export async function runBackdatedInsertion(
  io: BackdatedIO,
  args: {
    wellName: string;
    packetId: string;
    data: Record<string, unknown>;
    tankTopInches: number;
    cfg: WellChronoConfig;
    nowIso: string;
    maxAttempts?: number;
  },
): Promise<BackdatedOutcome> {
  const maxAttempts = args.maxAttempts ?? 3;
  const newInput: ChronoPullInput = {
    packetId: args.packetId,
    dateTimeUTC: String(args.data.dateTimeUTC),
    tankTopInches: args.tankTopInches,
    bblsTaken: Number(args.data.bblsTaken),
    wellDown: args.data.wellDown === true,
    submittedAtMs: typeof args.data.ingestedAt === 'number' ? args.data.ingestedAt : undefined,
    // Provenance carried so proven-duplicate collapse works; value-match alone never dedups.
    ...(typeof args.data.operationId === 'string' ? { operationId: args.data.operationId } : {}),
    ...(typeof args.data.recoveredFromPacketId === 'string' ? { recoveredFromPacketId: args.data.recoveredFromPacketId } : {}),
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // The ENTIRE read→compute→commit runs under the exclusive well lock, so no
    // other writer can interleave between our plan and our commit.
    const outcome = await io.withWellLock(args.wellName, async (): Promise<BackdatedOutcome> => {
      const revision = await io.readWellRevision(args.wellName);
      const existing = await io.loadWellPulls(args.wellName);
      const before = recomputeWell(existing, args.cfg);
      const after = recomputeWell(upsertPull(existing, newInput), args.cfg);
      const nextRevision = revision + 1;

      const plan = planBackdatedCommit({ before, after, newPacketId: args.packetId, wellRevision: nextRevision });
      if (plan.duplicateNoop) return { status: 'duplicate_noop' };

      const updates = {
        ...plan.updates,
        ...newRowChildUpdates(`packets/processed/${args.packetId}`, args.data, args.nowIso),
        [`wells/${args.wellName}/status/chronoRevision`]: nextRevision, // bump under lock
      };
      await io.commit(updates);
      return { status: 'inserted', changedPacketIds: plan.changedPacketIds, lateEntry: plan.insertedLateEntry, current: plan.currentPacketId, revision: nextRevision };
    });

    if (outcome.ran) return outcome.value;
    // Lock was contended — another writer holds it. Retry acquires fresh state
    // AFTER that writer commits, so we never overwrite it.
  }
  return { status: 'lock_contended' };
}
