// ───────────────────────────────────────────────────────────────────────────
// Photo-compliance requirement specs (dashboard side).
//
// Reads/writes photo_requirements/{customerId} — the SAME doc shape the seed
// script created and the validatePhotoCompliance CF + WB T consume. customerId
// is the operator slug (lowercase alphanumerics), identical to WB T's
// customerIdForOperator(). Sample images upload to the project's real Storage
// bucket (the dashboard's default config points at the non-existent appspot.com
// bucket, so we target firebasestorage.app explicitly — same bucket the CF
// reads from via admin SDK).
//
// On save we bump `version` so WB T's cache (keyed by customerId+version)
// refreshes. The { id, label, description, threshold, sampleStoragePath,
// sampleUrl } contract is preserved; requiredCount / phase / active are additive.
// ───────────────────────────────────────────────────────────────────────────
import { getFirebaseApp, getFirestoreDb } from './firebase';
import { doc, getDoc, setDoc, Timestamp } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

const REAL_BUCKET = 'gs://wellbuilt-sync.firebasestorage.app';

export type PhotoPhase = 'any' | 'pickup' | 'dropoff';

export interface PhotoRequirement {
  id: string;
  label: string;            // driver-facing button label, e.g. "Hose On"
  description: string;      // criteria text the vision model checks against
  threshold: number;        // 0–100 accept score (default 80)
  requiredCount: number;    // how many passing photos needed (default 1)
  phase: PhotoPhase;        // when the button shows (default 'any')
  active: boolean;          // per-requirement on/off (default true)
  sampleStoragePath?: string;
  sampleUrl?: string;
}

export interface PhotoRequirementSpec {
  customerId: string;
  enabled: boolean;
  version: number;
  requirements: PhotoRequirement[];
}

/** Operator → customerId slug. MUST match WB T's customerIdForOperator(). */
export function customerIdForOperator(operator: string | undefined | null): string {
  if (!operator) return '';
  return String(operator).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeReq(r: any): PhotoRequirement {
  return {
    id: String(r.id),
    label: String(r.label || r.id),
    description: String(r.description || r.label || ''),
    threshold: typeof r.threshold === 'number' ? r.threshold : 80,
    requiredCount: typeof r.requiredCount === 'number' && r.requiredCount >= 1 ? r.requiredCount : 1,
    phase: r.phase === 'pickup' || r.phase === 'dropoff' ? r.phase : 'any',
    active: r.active !== false,
    sampleStoragePath: r.sampleStoragePath || undefined,
    sampleUrl: r.sampleUrl || undefined,
  };
}

/** Load a customer's spec, or null if none exists yet. */
export async function loadPhotoRequirementSpec(customerId: string): Promise<PhotoRequirementSpec | null> {
  if (!customerId) return null;
  const snap = await getDoc(doc(getFirestoreDb(), 'photo_requirements', customerId));
  if (!snap.exists()) return null;
  const data = snap.data() as any;
  return {
    customerId,
    enabled: data.enabled !== false,
    version: typeof data.version === 'number' ? data.version : 0,
    requirements: Array.isArray(data.requirements) ? data.requirements.filter((r: any) => r && r.id).map(normalizeReq) : [],
  };
}

/**
 * Upload a sample/reference image for a requirement to the real bucket. Returns
 * the storage path (used by the CF) + a download URL (used for dashboard/app
 * display). Path matches the seed script: photo_requirements/{cid}/{reqId}.{ext}.
 */
export async function uploadRequirementSample(
  customerId: string,
  requirementId: string,
  file: File,
): Promise<{ sampleStoragePath: string; sampleUrl: string }> {
  const storage = getStorage(getFirebaseApp(), REAL_BUCKET);
  const ext = (file.type || '').toLowerCase().includes('png') ? 'png' : 'jpg';
  const sampleStoragePath = `photo_requirements/${customerId}/${requirementId}.${ext}`;
  const storageRef = ref(storage, sampleStoragePath);
  await uploadBytes(storageRef, file, { contentType: file.type || 'image/jpeg' });
  const sampleUrl = await getDownloadURL(storageRef);
  return { sampleStoragePath, sampleUrl };
}

/**
 * Write the full requirements array for a customer + bump the version so WB T
 * re-fetches. Reads the current version first (version is the cache key).
 */
export async function savePhotoRequirementSpec(
  customerId: string,
  requirements: PhotoRequirement[],
  enabled: boolean,
): Promise<number> {
  const ref0 = doc(getFirestoreDb(), 'photo_requirements', customerId);
  const cur = await getDoc(ref0);
  const curVersion = cur.exists() && typeof (cur.data() as any).version === 'number' ? (cur.data() as any).version : 0;
  const version = curVersion + 1;
  await setDoc(
    ref0,
    {
      customerId,
      enabled,
      version,
      requirements: requirements.map(normalizeReq),
      updatedAt: Timestamp.now(),
    },
    { merge: true },
  );
  return version;
}
