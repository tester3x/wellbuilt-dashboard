// mutationAdmission.ts — governed WB-M mutation admission gate (predeploy gate
// Blocker 3). During a staged rollout the operator CLOSES the gate so no new
// CREATE/EDIT input enters packets/incoming while the canonical triggers are
// swapped; already-accepted incoming work stays drainable, and paused
// producers return a RETRYABLE error so clients retain (never drop or falsely
// deliver) their queued packet.
//
// The flag lives at a SERVER-OWNED path (deployed rules deny client writes):
//   system/maintenance/wbmMutations = { paused: bool, reason, at, by }
// It is set only by the deploy operator (Admin SDK) — never by a packet field.
import * as admin from 'firebase-admin';

export const MUTATION_ADMISSION_PATH = 'system/maintenance/wbmMutations';
/** Callable error code returned when paused — a retryable class for clients. */
export const MAINTENANCE_ERROR_CODE = 'unavailable' as const;
export const MAINTENANCE_REASON = 'wbm_mutations_paused' as const;

export interface AdmissionDecision {
  admitted: boolean;
  reason: string;
}

/** Pure: decide from the raw flag value. Fail OPEN on absent/malformed — a
 *  missing flag must never wedge production; only an explicit `paused:true`
 *  closes the gate. */
export function decideAdmission(raw: unknown): AdmissionDecision {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { paused?: unknown }).paused === true) {
    const reason = (raw as { reason?: unknown }).reason;
    return { admitted: false, reason: typeof reason === 'string' && reason ? reason : MAINTENANCE_REASON };
  }
  return { admitted: true, reason: 'open' };
}

/** Read the live flag (Admin SDK) and decide. Any read error fails OPEN. */
export async function checkMutationAdmission(
  db: admin.database.Database = admin.database(),
): Promise<AdmissionDecision> {
  try {
    const snap = await db.ref(MUTATION_ADMISSION_PATH).once('value');
    return decideAdmission(snap.val());
  } catch {
    return { admitted: true, reason: 'open_on_read_error' };
  }
}
