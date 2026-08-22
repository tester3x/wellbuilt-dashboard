/**
 * Apply-path RTDB write for canonical WB-M assignment.
 *
 * Admin SDK transactions abort immediately if the update function returns
 * undefined on a false-null first call (incomplete listener cache). A prior
 * once() does not keep that cache. Prime a path-specific value listener, then
 * read the transaction `current` as the only write authority.
 *
 * No module-level profile/digest cache. Each call holds its own listener
 * and removes only that listener.
 */
import {
  evaluateAssignmentTransaction,
} from './assignmentScope';

export type AssignmentProfileRef = {
  on(
    event: 'value',
    callback: (...args: unknown[]) => void,
    cancelCallback?: (err: Error) => void,
  ): unknown;
  off(event: 'value', callback?: (...args: unknown[]) => void): void;
  transaction(
    update: (current: unknown) => unknown,
  ): Promise<{
    committed: boolean;
    snapshot: { exists(): boolean; val(): unknown };
  }>;
};

export type AssignmentApplyResult =
  | { ok: true; assignmentRevision: number; written: Record<string, unknown> }
  | { ok: false; reason: string };

export async function commitCanonicalAssignmentWrite(input: {
  profileRef: AssignmentProfileRef;
  driverId: string;
  expectedPreviewContextDigest: string;
  proposedRoutes: string[];
  proposedWells: string[];
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
  callerUid: string;
  nowMs: number;
}): Promise<AssignmentApplyResult> {
  let abortReason = 'stale_preview';
  let resolvePrime: () => void = () => undefined;
  const listener = () => { resolvePrime(); };
  try {
    await new Promise<void>((resolve, reject) => {
      resolvePrime = resolve;
      input.profileRef.on('value', listener, (err) => reject(err));
    });
    const tx = await input.profileRef.transaction((current) => {
      const rec = current && typeof current === 'object' && !Array.isArray(current)
        ? current as Record<string, unknown>
        : null;
      const gate = evaluateAssignmentTransaction({
        driverId: input.driverId,
        profile: rec,
        expectedPreviewContextDigest: input.expectedPreviewContextDigest,
        proposedRoutes: input.proposedRoutes,
        proposedWells: input.proposedWells,
        callerCompanyId: input.callerCompanyId,
        isPlatformAdmin: input.isPlatformAdmin,
      });
      if (!rec) {
        abortReason = 'profile_missing';
        return;
      }
      if (!gate.ok) {
        abortReason = gate.reason;
        return;
      }
      return {
        ...rec,
        assignedRoutes: input.proposedRoutes,
        assignedWells: input.proposedWells,
        assignmentRevision: gate.nextRevision,
        assignmentUpdatedAt: input.nowMs,
        assignmentUpdatedBy: input.callerUid,
      };
    });
    if (!tx.committed || !tx.snapshot.exists()) {
      return { ok: false, reason: abortReason };
    }
    const written = (tx.snapshot.val() || {}) as Record<string, unknown>;
    const assignmentRevision = typeof written.assignmentRevision === 'number'
      ? written.assignmentRevision
      : 0;
    return { ok: true, assignmentRevision, written };
  } finally {
    input.profileRef.off('value', listener);
  }
}
