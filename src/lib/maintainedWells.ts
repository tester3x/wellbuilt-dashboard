// Tenant "maintained wells" membership layer (Model B).
//
// Shared physical telemetry stays in RTDB `well_config` (untouched — WB M and
// the Cloud Functions depend on it). Tenant OWNERSHIP lives in a SEPARATE RTDB
// node `maintained_wells/{companyId}/{wellName}: true`, so we never put
// companyId on the shared well_config.
//
// Stored in RTDB (not Firestore) because RTDB is open (.read/.write) — no rules
// deploy needed tonight. Tenant isolation is enforced client-side for now, the
// same posture as the rest of the app (well_config etc. are already open); rules
// hardening is a later phase. `wellName` matches the well_config key exactly, so
// dashboard reads filter the global well_config to a company's set. well_config
// keys already strip RTDB-illegal chars (.#$[]/), so they're valid path keys.

import { getFirebaseDatabase } from './firebase';
import { ref, set, remove, get, onValue } from 'firebase/database';

const NODE = 'maintained_wells';

/** Mark a well as maintained by a company (idempotent). */
export async function addMaintainedWell(companyId: string, wellName: string): Promise<void> {
  if (!companyId || !wellName) return;
  await set(ref(getFirebaseDatabase(), `${NODE}/${companyId}/${wellName}`), true);
}

/** Remove a well's membership for a company (no-op if absent). */
export async function removeMaintainedWell(companyId: string, wellName: string): Promise<void> {
  if (!companyId || !wellName) return;
  await remove(ref(getFirebaseDatabase(), `${NODE}/${companyId}/${wellName}`));
}

/** One-time fetch of the set of well names a company maintains. */
export async function getMaintainedWellNames(companyId: string): Promise<Set<string>> {
  if (!companyId) return new Set();
  const snap = await get(ref(getFirebaseDatabase(), `${NODE}/${companyId}`));
  return new Set(Object.keys(snap.val() || {}));
}

/**
 * Subscribe to a company's maintained well-name set. cb fires with a fresh Set
 * on every change. Returns the unsubscribe.
 */
export function subscribeMaintainedWellNames(
  companyId: string,
  cb: (names: Set<string>) => void,
): () => void {
  return onValue(
    ref(getFirebaseDatabase(), `${NODE}/${companyId}`),
    (snap) => cb(new Set(Object.keys(snap.val() || {}))),
    (err) => { console.error('[maintainedWells] subscribe error:', err); },
  );
}
