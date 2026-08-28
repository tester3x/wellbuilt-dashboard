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
  /** All of the well's processed pulls as engine inputs. */
  loadWellPulls(wellName: string): Promise<ChronoPullInput[]>;
  /** Current per-well chronological revision (monotonic). */
  readWellRevision(wellName: string): Promise<number>;
  /** Apply the atomic update ONLY if the well revision is still `expected`
   *  (fences out a stale worker / concurrent newer pull); bumps the revision on
   *  success. Returns 'stale_revision' when a newer version has committed. */
  commitFenced(wellName: string, expected: number, updates: Record<string, unknown>): Promise<'committed' | 'stale_revision'>;
}

export type BackdatedOutcome =
  | { status: 'inserted'; changedPacketIds: string[]; lateEntry: boolean; current: string | null }
  | { status: 'duplicate_noop' }
  | { status: 'stale_revision' };

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
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const revision = await io.readWellRevision(args.wellName);
    const existing = await io.loadWellPulls(args.wellName);
    const before = recomputeWell(existing, args.cfg);
    const after = recomputeWell(upsertPull(existing, newInput), args.cfg);
    const nextRevision = revision + 1;

    const plan = planBackdatedCommit({ before, after, newPacketId: args.packetId, wellRevision: nextRevision });
    if (plan.duplicateNoop) return { status: 'duplicate_noop' };

    // Fold in the new row's material fields so the single commit creates the full
    // record (child-key writes only → no parent/child path conflict).
    const updates = {
      ...plan.updates,
      ...newRowChildUpdates(`packets/processed/${args.packetId}`, args.data, args.nowIso),
    };

    const result = await io.commitFenced(args.wellName, revision, updates);
    if (result === 'committed') {
      return { status: 'inserted', changedPacketIds: plan.changedPacketIds, lateEntry: plan.insertedLateEntry, current: plan.currentPacketId };
    }
    // stale_revision → a newer pull committed during recompute; retry with fresh state.
  }
  return { status: 'stale_revision' };
}
