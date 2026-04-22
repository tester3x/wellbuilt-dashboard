import * as admin from 'firebase-admin';

/**
 * Phase 21 — runtime SWD reference loader.
 *
 * Reads admin-added SWD reference entries from RTDB:
 *   truth_reference/swd_catalog/{safeKey}
 *
 * Record shape (written by `addTruthSwdReference`):
 *   name:           string  // raw display form as typed by admin
 *   normalizedName: string  // pre-normalized for match-set construction
 *   type:           'swd'
 *   addedAt:        string  // ISO 8601
 *   addedByUid:     string
 *   addedByEmail?:  string
 *   active:         boolean // false records are filtered out here
 *
 * Returns only ACTIVE records (inactive entries don't participate in
 * matching). The caller merges these with the static seed via
 * `buildSwdReferenceSet()` to produce the combined match set.
 *
 * Best-effort: errors are caught and returned via `sourceError`. The
 * Truth Debug page surfaces loader errors in its sourceErrors list.
 * A load failure means "use the static seed only, don't crash the
 * shadow read."
 */
export interface LoadSwdReferenceRuntimeResult {
  /** Only active entries, shape trimmed to what the match set needs. */
  entries: Array<{ name: string }>;
  /** Count of entries returned (== entries.length). */
  count: number;
  /** Count of inactive entries skipped — useful diagnostic only. */
  inactiveCount: number;
  sourceError?: string;
}

type AnyRecord = Record<string, unknown>;

function isObject(v: unknown): v is AnyRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export async function loadSwdReferenceRuntime(): Promise<LoadSwdReferenceRuntimeResult> {
  try {
    const snap = await admin
      .database()
      .ref('truth_reference/swd_catalog')
      .once('value');

    if (!snap.exists()) {
      return { entries: [], count: 0, inactiveCount: 0 };
    }

    const raw = snap.val();
    if (!isObject(raw)) {
      return { entries: [], count: 0, inactiveCount: 0 };
    }

    const entries: Array<{ name: string }> = [];
    let inactiveCount = 0;

    for (const value of Object.values(raw)) {
      if (!isObject(value)) continue;
      // Shape check: require a usable `name` string.
      const name = value.name;
      if (typeof name !== 'string' || name.trim().length === 0) continue;
      // Only active records participate in matching. Default when the
      // field is missing / non-boolean is to treat as active so older
      // shapes (if any predate this field) don't silently drop out.
      if (value.active === false) {
        inactiveCount += 1;
        continue;
      }
      entries.push({ name: name.trim() });
    }

    return { entries, count: entries.length, inactiveCount };
  } catch (err) {
    return {
      entries: [],
      count: 0,
      inactiveCount: 0,
      sourceError: `swd_catalog: ${(err as Error).message}`,
    };
  }
}

/**
 * Build the safeKey used at the RTDB write path. Shared with the
 * writer callable so writes and reads never drift in format.
 *
 *   input:      a name pre-normalized via
 *               `normalizeLocationNameForOfficialMatch(...)`
 *   output:     RTDB-path-safe key — strips illegal chars (. # $ [ ] /)
 *               and swaps spaces for underscores for readability.
 *
 * Example: "wo watford #1"  →  "wo_watford__1"
 */
export function normalizedSwdNameToSafeKey(normalized: string): string {
  return normalized.replace(/[.#$[\]/]/g, '_').replace(/ /g, '_');
}
