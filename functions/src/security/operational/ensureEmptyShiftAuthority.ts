/**
 * Server-side ensure of an initialized empty shift-authority pointer for a
 * newly provisioned (or migrated) canonical driver.
 *
 * Used by secure onboarding callables. Side-effect free when companyId is
 * absent. Never writes under a legacy passcode-hash key.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  decideEnsureEmptyAuthority,
  shiftAuthorityPath,
  type EnsureEmptyAuthorityDecision,
  type ShiftAuthorityRecord,
} from './shiftAuthority';

function readRecord(data: Record<string, unknown> | undefined): ShiftAuthorityRecord | null {
  if (!data) return null;
  const { driverId, companyId, initialized, openPeriodId, originLocalDate, version } = data;
  if (typeof driverId !== 'string' || typeof companyId !== 'string'
      || typeof initialized !== 'boolean' || typeof version !== 'number') {
    return null;
  }
  return {
    driverId,
    companyId,
    initialized,
    openPeriodId: typeof openPeriodId === 'string' ? openPeriodId : null,
    originLocalDate: typeof originLocalDate === 'string' ? originLocalDate : null,
    lastClosedPeriodId: typeof data.lastClosedPeriodId === 'string' ? data.lastClosedPeriodId : null,
    version,
  };
}

export type EnsureEmptyAuthorityResult = {
  decision: EnsureEmptyAuthorityDecision;
  /** True when a write was applied. */
  wrote: boolean;
};

/**
 * Transactionally ensure empty initialized authority for a company-bound driver.
 *
 * @returns decision for bounded audit (no secrets). Refuse does not throw here.
 */
export async function ensureInitializedEmptyShiftAuthority(
  db: Firestore,
  input: { driverId: string; companyId: string | null | undefined },
): Promise<EnsureEmptyAuthorityResult> {
  const pre = decideEnsureEmptyAuthority({
    driverId: input.driverId,
    companyId: input.companyId,
    existing: null,
  });
  if (pre.action === 'skip') {
    return { decision: pre, wrote: false };
  }

  const ref = db.doc(shiftAuthorityPath(input.driverId.trim()));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existing = readRecord(snap.data() as Record<string, unknown>);
      if (!existing) {
        return {
          decision: { action: 'refuse', reason: 'malformed_record' },
          wrote: false,
        };
      }
      const d = decideEnsureEmptyAuthority({
        driverId: input.driverId,
        companyId: input.companyId,
        existing,
      });
      if (d.action === 'initialize_uninitialized') {
        tx.update(ref, {
          driverId: d.record.driverId,
          companyId: d.record.companyId,
          initialized: true,
          openPeriodId: null,
          originLocalDate: null,
          version: d.record.version + 1,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { decision: d, wrote: true };
      }
      return { decision: d, wrote: false };
    }

    const d = decideEnsureEmptyAuthority({
      driverId: input.driverId,
      companyId: input.companyId,
      existing: null,
    });
    if (d.action === 'create') {
      // create fails if a concurrent writer inserted first — transaction retries.
      tx.create(ref, {
        ...d.record,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { decision: d, wrote: true };
    }
    return { decision: d, wrote: false };
  });
}

/**
 * After ensure: throw if refuse so onboarding does not report success without
 * a usable authority when a company was bound.
 */
export function assertEnsureAuthorityOk(result: EnsureEmptyAuthorityResult): void {
  if (result.decision.action === 'refuse') {
    const err = new Error(`shift_authority_ensure_refused:${result.decision.reason}`);
    (err as Error & { code: string }).code = 'failed-precondition';
    throw err;
  }
}
