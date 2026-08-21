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
import { getFirestoreDb, getFirebaseFunctions } from './firebase';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

const REAL_BUCKET = 'gs://wellbuilt-sync.firebasestorage.app';

// pickup = before Depart · dropoff = before Close · both = one at pickup AND one
// at drop-off. (Legacy 'any' specs normalize to 'pickup' on load — see
// normalizeReq. No "anywhere before close" option.)
export type PhotoPhase = 'pickup' | 'dropoff' | 'both';
export type PhotoAppliesTo = 'any' | 'pw' | 'sw';
// Provenance of a requirement. 'wb-default' = seeded from DEFAULT_PHOTO_REQUIREMENTS
// (eligible for Reset-to-default by matching id); 'customer' = customer-created.
// Optional + additive: existing docs have no `source` and are treated as customer
// config. The CF and WB T never read this field — it is dashboard metadata only.
export type PhotoReqSource = 'wb-default' | 'customer';

export interface PhotoRequirement {
  id: string;
  label: string;            // driver-facing button label, e.g. "Hose On"
  description: string;      // criteria text the vision model checks against
  threshold: number;        // 0–100 accept score (default 80)
  requiredCount: number;    // how many passing photos needed (default 1)
  phase: PhotoPhase;        // when the button shows (default 'pickup')
  appliesTo: PhotoAppliesTo; // which job type the slot shows on (default 'any')
  active: boolean;          // per-requirement on/off (default true)
  sampleStoragePath?: string;
  sampleUrl?: string;
  source?: PhotoReqSource;  // additive (Phase 1) — provenance for reset; optional
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
    // Legacy 'any' (and any unknown/missing value) migrates to 'pickup'.
    phase: r.phase === 'dropoff' || r.phase === 'both' ? r.phase : 'pickup',
    appliesTo: r.appliesTo === 'pw' || r.appliesTo === 'sw' ? r.appliesTo : 'any',
    active: r.active !== false,
    // Optional fields are OMITTED when absent — never written as `undefined`,
    // which Firestore setDoc rejects. (A requirement with no uploaded sample,
    // e.g. a freshly-seeded customer, would otherwise serialize undefined here.)
    ...(r.sampleStoragePath ? { sampleStoragePath: r.sampleStoragePath } : {}),
    ...(r.sampleUrl ? { sampleUrl: r.sampleUrl } : {}),
    // Pass through only when explicitly set, so existing (sourceless) docs stay
    // sourceless until something deliberately stamps them.
    ...(r.source === 'wb-default' || r.source === 'customer' ? { source: r.source } : {}),
  };
}

/**
 * Deep-strip `undefined` values from an object/array so a save payload can never
 * carry an undefined field (which Firestore setDoc rejects). Defense-in-depth on
 * top of normalizeReq — applied to the whole doc right before setDoc.
 */
function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefinedDeep(v)) as unknown as T;
  }
  if (value && typeof value === 'object' && !(value instanceof Timestamp)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      if (v === undefined) continue;
      out[k] = stripUndefinedDeep(v);
    }
    return out as T;
  }
  return value;
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
  _customerId: string,
  _requirementId: string,
  _file: File,
): Promise<{ sampleStoragePath: string; sampleUrl: string }> {
  // Direct Storage writes are denied. Sample objects must be issued through
  // a tenant-bound grant; no such staff callable is exported yet.
  throw new Error('UPDATE_REQUIRED: photo requirement sample upload is not available in this version');
}

/**
 * AI drafting helper — analyze the requirement's sample photo and return a
 * field-friendly criteria draft. Drafting only; the admin reviews/edits/saves.
 */
export async function suggestPhotoCriteria(params: {
  customerId: string;
  requirementId?: string;
  sampleStoragePath?: string;
  sampleUrl?: string;
  label?: string;
  phase?: string;
  hint?: string;
}): Promise<{ criteria: string; suggestedThreshold?: number; notes?: string }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'suggestPhotoCriteria');
  const res: any = await fn(params);
  return res.data;
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
  const current = await loadPhotoRequirementSpec(customerId);
  const fn = httpsCallable(getFirebaseFunctions(), 'upsertPhotoRequirementSpec');
  const res: any = await fn({
    customerId,
    requirements: requirements.map(normalizeReq),
    enabled,
    expectedVersion: current?.version ?? 0,
  });
  return typeof res?.data?.version === 'number' ? res.data.version : 0;
}
