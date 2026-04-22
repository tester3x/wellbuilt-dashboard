import type {
  LocationConvergenceDisposition,
  LocationConvergencePreview,
} from './types.locationHealth';

/**
 * Phase 14 — preview anchor. Priority (spec §3):
 *   1. preferredName if present
 *   2. official-backed display (ndic / official) if clearly available
 *   3. fall back to preferredName (even if empty)
 *
 * Current data always populates preferredName, so priorities 2 and 3 are
 * defensive. Never invents a name — only chooses among values already on
 * the diagnostic.
 */
function deriveUnifiedDisplayName(
  preferredName: string,
  ndicName: string | undefined,
  officialName: string | undefined
): string {
  if (preferredName && preferredName.trim().length > 0) return preferredName;
  if (ndicName && ndicName.trim().length > 0) return ndicName;
  if (officialName && officialName.trim().length > 0) return officialName;
  return preferredName;
}

/**
 * Phase 14 — count how many aliases would collapse into the anchor during
 * a hypothetical convergence. "Collapse" means raw-string-different from the
 * anchor. Stable equality (case-sensitive) matches Phase 12's
 * aliasConflictCount semantics; the "which specific kind of variation"
 * question is answered by previewConflictFlags.
 */
function countAliasCollapse(aliases: ReadonlyArray<string>, anchor: string): number {
  let n = 0;
  for (const a of aliases) {
    if (a !== anchor) n += 1;
  }
  return n;
}

/**
 * Phase 14 — classify alias variations using layered normalization buckets.
 * Only looks at aliases already on the diagnostic; no fuzzy matching, no
 * invented equivalence. Flags returned as a deterministic sorted set.
 *
 *   case_variation        — same content, casing only differs
 *   spacing_variation     — internal whitespace differs (extra spaces)
 *   punctuation_variation — punctuation/non-alphanumeric characters differ
 *   alias_variation       — multiple distinct aliases but no specific kind fired
 *
 * Rules fire independently. Multiple can fire on the same alias set.
 */
function detectAliasVariationFlags(aliases: ReadonlyArray<string>): string[] {
  if (aliases.length <= 1) return [];

  const flags = new Set<string>();

  // Bucket 1: trim-only (preserve case + punctuation + internal spacing).
  const rawTrimmed = new Set(aliases.map((a) => a.trim()).filter((a) => a.length > 0));
  // Bucket 2: trim + collapse internal whitespace (still case-preserving).
  const spaceCollapsed = new Set(
    aliases.map((a) => a.trim().replace(/\s+/g, ' ')).filter((a) => a.length > 0)
  );
  // Bucket 3: bucket 2 + lowercase.
  const caseCollapsed = new Set(
    aliases
      .map((a) => a.trim().replace(/\s+/g, ' ').toLowerCase())
      .filter((a) => a.length > 0)
  );
  // Bucket 4: bucket 3 + strip non-alphanumeric.
  const punctCollapsed = new Set(
    aliases
      .map((a) => a.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter((a) => a.length > 0)
  );

  if (spaceCollapsed.size < rawTrimmed.size) flags.add('spacing_variation');
  if (caseCollapsed.size < spaceCollapsed.size) flags.add('case_variation');
  if (punctCollapsed.size < caseCollapsed.size) flags.add('punctuation_variation');

  const hasSpecific =
    flags.has('spacing_variation') ||
    flags.has('case_variation') ||
    flags.has('punctuation_variation');

  // Catch-all — multiple distinct aliases but the variation is something else
  // (different content entirely, numeric differences, etc.). Emit
  // alias_variation so the caller knows the group isn't clean.
  if (!hasSpecific && rawTrimmed.size > 1) {
    flags.add('alias_variation');
  }

  return Array.from(flags).sort();
}

export interface LocationConvergencePreviewInput {
  disposition: LocationConvergenceDisposition;
  preferredName: string;
  aliases: ReadonlyArray<string>;
  ndicName?: string;
  officialName?: string;
  aliasConflictCount: number;
  hasMixedSourceKinds: boolean;
}

/**
 * Phase 14 — preview-only simulation of hypothetical future convergence.
 * Returns undefined for disposition === 'exclude' (excluded locations are
 * not part of the review queue today). Pure + deterministic.
 *
 * The preview NEVER mutates data or drives behavior — it only answers:
 *   - If this location were approved for convergence later, what would
 *     the anchor display name be?
 *   - How many aliases would collapse under it?
 *   - What preview-only risks would a reviewer want to see?
 *
 * Protecting custom/operational reality: excluded diagnostics are still
 * fully visible elsewhere. They just don't receive a preview here.
 */
export function deriveLocationConvergencePreview(
  input: LocationConvergencePreviewInput
): LocationConvergencePreview | undefined {
  if (input.disposition === 'exclude') return undefined;

  const unifiedDisplayName = deriveUnifiedDisplayName(
    input.preferredName,
    input.ndicName,
    input.officialName
  );
  const aliasCollapseCount = countAliasCollapse(input.aliases, unifiedDisplayName);
  const wouldCollapseAliases = aliasCollapseCount > 0;

  const flagSet = new Set<string>(detectAliasVariationFlags(input.aliases));
  if (input.hasMixedSourceKinds) flagSet.add('mixed_source_context');
  if (input.disposition === 'hold' && input.aliasConflictCount > 0) {
    flagSet.add('review_required');
  }

  const previewConflictFlags = Array.from(flagSet).sort();

  return {
    unifiedDisplayName,
    aliasCollapseCount,
    wouldCollapseAliases,
    previewConflictFlags,
  };
}
