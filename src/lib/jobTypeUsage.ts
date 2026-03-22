// Job Type Usage Tracking — R&D Pipeline
//
// Tracks how often each job type is dispatched across all companies.
// Used for:
//   - Auto-promoting popular custom job types to official packages
//   - Auto-pruning unused built-in job types
//   - WB admin R&D dashboard view
//
// Firestore: job_type_usage/{normalizedLabel}
//   { label, totalDispatches, companyIds[], lastUsed, isCustom, firstSeen, source }

import { doc, getDoc, setDoc, getDocs, collection, increment, arrayUnion, Timestamp } from 'firebase/firestore';
import { getFirestoreDb } from './firebase';

export interface JobTypeUsageEntry {
  id: string;              // Firestore doc ID (normalized label)
  label: string;           // Display label (e.g. "Slickline")
  totalDispatches: number; // Total times dispatched across all companies
  companyIds: string[];    // Unique companies that have used this type
  lastUsed: any;           // Timestamp of last dispatch
  firstSeen: any;          // When this type first appeared
  isCustom: boolean;       // true = company-added, false = package built-in
  source: string;          // packageId or 'custom'
}

// Thresholds — LOW for testing, raise for production
export const PROMOTE_THRESHOLD_COMPANIES = 2;  // Custom used by 2+ companies → flag for promotion
export const PROMOTE_THRESHOLD_DISPATCHES = 3; // And at least 3 total dispatches
export const PRUNE_THRESHOLD_DAYS = 7;         // Built-in with 0 dispatches in 7 days → flag for removal

/** Normalize a job type label for use as Firestore doc ID */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Record a dispatch for a job type. Call this when creating a dispatch. */
export async function trackJobTypeUsage(
  serviceType: string,
  companyId: string,
  packageId: string
): Promise<void> {
  try {
    const firestore = getFirestoreDb();
    const docId = normalizeLabel(serviceType);
    const ref = doc(firestore, 'job_type_usage', docId);

    const existing = await getDoc(ref);
    if (existing.exists()) {
      // Update existing
      await setDoc(ref, {
        totalDispatches: increment(1),
        companyIds: arrayUnion(companyId),
        lastUsed: Timestamp.now(),
      }, { merge: true });
    } else {
      // Create new
      await setDoc(ref, {
        label: serviceType,
        totalDispatches: 1,
        companyIds: [companyId],
        lastUsed: Timestamp.now(),
        firstSeen: Timestamp.now(),
        isCustom: packageId === 'custom',
        source: packageId,
      });
    }
  } catch (err) {
    // Non-blocking — don't fail dispatch if tracking fails
    console.warn('[R&D] Failed to track job type usage:', err);
  }
}

/** Load all usage entries for the R&D dashboard */
export async function loadAllUsage(): Promise<JobTypeUsageEntry[]> {
  const firestore = getFirestoreDb();
  const snap = await getDocs(collection(firestore, 'job_type_usage'));
  const entries: JobTypeUsageEntry[] = [];
  snap.forEach(d => {
    entries.push({ id: d.id, ...d.data() } as JobTypeUsageEntry);
  });
  return entries.sort((a, b) => b.totalDispatches - a.totalDispatches);
}

/** Get custom types that should be promoted (used by enough companies) */
export function getPromotionCandidates(entries: JobTypeUsageEntry[]): JobTypeUsageEntry[] {
  return entries.filter(e =>
    e.isCustom &&
    e.companyIds.length >= PROMOTE_THRESHOLD_COMPANIES &&
    e.totalDispatches >= PROMOTE_THRESHOLD_DISPATCHES
  );
}

/** Get built-in types that should be pruned (unused for too long) */
export function getPruneCandidates(entries: JobTypeUsageEntry[]): JobTypeUsageEntry[] {
  const cutoff = Date.now() - (PRUNE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
  return entries.filter(e => {
    if (e.isCustom) return false; // Only prune built-ins
    if (e.totalDispatches === 0) return true; // Never used
    const lastUsedMs = e.lastUsed?.toDate?.()
      ? e.lastUsed.toDate().getTime()
      : e.lastUsed?.seconds
        ? e.lastUsed.seconds * 1000
        : 0;
    return lastUsedMs > 0 && lastUsedMs < cutoff;
  });
}

/** Seed test data — dumb job titles with artificial usage for testing */
export async function seedTestData(): Promise<void> {
  const firestore = getFirestoreDb();

  const testEntries = [
    {
      id: 'unicorn-delivery',
      label: 'Unicorn Delivery',
      totalDispatches: 4,
      companyIds: ['liquidgold', 'testco', 'acme-hauling'],
      isCustom: true,
      source: 'custom',
    },
    {
      id: 'sasquatch-removal',
      label: 'Sasquatch Removal',
      totalDispatches: 5,
      companyIds: ['liquidgold', 'testco'],
      isCustom: true,
      source: 'custom',
    },
    {
      id: 'dragon-wrangling',
      label: 'Dragon Wrangling',
      totalDispatches: 1,
      companyIds: ['testco'],
      isCustom: true,
      source: 'custom',
    },
    {
      id: 'rig-move',
      label: 'Rig Move',
      totalDispatches: 0,
      companyIds: [],
      isCustom: false,
      source: 'water-hauling',
    },
    {
      id: 'tank-cleanout',
      label: 'Tank Cleanout',
      totalDispatches: 0,
      companyIds: [],
      isCustom: false,
      source: 'water-hauling',
    },
  ];

  for (const entry of testEntries) {
    const ref = doc(firestore, 'job_type_usage', entry.id);
    await setDoc(ref, {
      ...entry,
      lastUsed: entry.totalDispatches > 0 ? Timestamp.now() : Timestamp.fromDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
      firstSeen: Timestamp.fromDate(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)),
    });
  }

  console.log('[R&D] Seeded test usage data');
}
