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
 */
const NORMALIZED_SWD_INDEX: ReadonlySet<string> = new Set(
  SWD_REFERENCE.map((entry) => normalizeLocationNameForOfficialMatch(entry.name))
);

export function isOfficialSwd(name: string | undefined | null): boolean {
  if (typeof name !== 'string') return false;
  const normalized = normalizeLocationNameForOfficialMatch(name);
  if (normalized.length === 0) return false;
  return NORMALIZED_SWD_INDEX.has(normalized);
}

/**
 * Exposed for tests / admin debug tooling. Returns a fresh array so
 * callers can't mutate the underlying set.
 */
export function getSwdReferenceNames(): string[] {
  return SWD_REFERENCE.map((e) => e.name);
}
