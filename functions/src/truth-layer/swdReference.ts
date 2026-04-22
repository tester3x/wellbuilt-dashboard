import { SWD_REFERENCE } from './data/swdReference';
import { normalizeLocationNameForOfficialMatch } from './normalizeOfficialLocationName';

/**
 * Phase 18 — exact-match lookup against the SWD reference dataset under
 * Phase 18 normalization (see normalizeOfficialLocationName.ts).
 *
 * Pure, deterministic, no I/O. Match = normalized equality, no partial
 * matching, no fuzzy scoring, no token-contains logic. Returns false
 * for undefined / blank inputs.
 *
 * Intentionally independent of the Phase 1-11 catalog path in
 * `normalizeLocation.ts`. That path already feeds NDIC / well_config
 * entries into canonical resolution; Phase 18 reference matching runs
 * at the diagnostic-signal level AFTER canonical projection, so it can
 * pick up names that dropped through catalog normalization because of
 * operator suffixes or punctuation differences on the catalog side.
 *
 * Phase 21 — the match set is now hybrid: static seed + optional
 * runtime entries from the RTDB `truth_reference/swd_catalog` path,
 * merged via `buildSwdReferenceSet()`. `isOfficialSwd(name, overrideSet)`
 * accepts the combined set, falling back to the static-only set when
 * no override is provided (preserves back-compat for tests + consumers
 * that predate the runtime plumbing).
 */
const STATIC_NORMALIZED_SWD_INDEX: ReadonlySet<string> = new Set(
  SWD_REFERENCE.map((entry) => normalizeLocationNameForOfficialMatch(entry.name))
);

/**
 * Phase 21 — build a combined normalized-name set from the static seed
 * plus any runtime entries (e.g. admin-added entries loaded from
 * RTDB). Always deduped via Set semantics. Runtime entries with the
 * same normalized form as a static entry silently fold in (no-op).
 *
 * Pure. No I/O. Caller is responsible for loading runtime entries.
 */
export interface SwdReferenceRuntimeEntry {
  name: string;
}

export interface BuildSwdReferenceSetOptions {
  /**
   * When false, exclude the static seed list and build a set from the
   * runtime entries only. Used by tests that want to assert the
   * runtime-only path. Default true.
   */
  includeStatic?: boolean;
}

export function buildSwdReferenceSet(
  runtimeEntries: ReadonlyArray<SwdReferenceRuntimeEntry> = [],
  options: BuildSwdReferenceSetOptions = {}
): ReadonlySet<string> {
  const includeStatic = options.includeStatic !== false;
  const set = new Set<string>();
  if (includeStatic) {
    for (const normalized of STATIC_NORMALIZED_SWD_INDEX) {
      set.add(normalized);
    }
  }
  for (const entry of runtimeEntries) {
    if (!entry || typeof entry.name !== 'string') continue;
    const normalized = normalizeLocationNameForOfficialMatch(entry.name);
    if (normalized.length > 0) set.add(normalized);
  }
  return set;
}

/**
 * `overrideSet` — Phase 21. When provided, this set is checked instead
 * of the module-level static-only index. Callers that need to fold
 * runtime-loaded entries into the match pool build a set via
 * `buildSwdReferenceSet()` and thread it through here.
 */
export function isOfficialSwd(
  name: string | undefined | null,
  overrideSet?: ReadonlySet<string>
): boolean {
  if (typeof name !== 'string') return false;
  const normalized = normalizeLocationNameForOfficialMatch(name);
  if (normalized.length === 0) return false;
  if (overrideSet) return overrideSet.has(normalized);
  return STATIC_NORMALIZED_SWD_INDEX.has(normalized);
}

/**
 * Exposed for tests / admin debug tooling. Returns a fresh array so
 * callers can't mutate the underlying set. Static seed only — runtime
 * entries are NOT reflected here. Use `buildSwdReferenceSet()` +
 * iterate the set if you need the combined view.
 */
export function getSwdReferenceNames(): string[] {
  return SWD_REFERENCE.map((e) => e.name);
}
