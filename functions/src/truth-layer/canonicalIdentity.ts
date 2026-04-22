import type { OperatorCanonicalView, CanonicalProjection } from './types.canonical';

export type IdentityConfidence = 'strong' | 'weak';

export interface SourceIdentities {
  hasHash?: boolean;
  hasUid?: boolean;
  hasNameOnly?: boolean;
}

export interface CanonicalOperatorIndexEntry {
  displayName?: string;
  legalName?: string;
  linkedKeys: string[];
  confidence: OperatorCanonicalView['confidence'];
  identityConfidence: IdentityConfidence;
  sourceIdentities: SourceIdentities;
}

export type CanonicalOperatorIndex = Record<string, CanonicalOperatorIndexEntry>;

/**
 * Source-identity classification of a canonical operator. Derived ONLY from
 * the keys actually observed in the raw truth layer — never inferred.
 *
 *   op:${hash}           -> hash-based identity
 *   op-uid:${uid}        -> Firebase-Auth-uid-based identity
 *   op-name:${normalized}-> name-only identity (weakest)
 *   op-unresolved:...    -> unresolved fallback (treated as name-only weak)
 */
export function getSourceIdentities(
  view: OperatorCanonicalView
): SourceIdentities {
  const out: SourceIdentities = {};
  for (const key of view.linkedKeys) {
    if (key.startsWith('op:')) out.hasHash = true;
    else if (key.startsWith('op-uid:')) out.hasUid = true;
    else if (key.startsWith('op-name:')) out.hasNameOnly = true;
  }
  return out;
}

/**
 * Identity confidence:
 *   strong — hash or uid identity is present
 *   weak   — only name-only (or unresolved) identity is present
 *
 * This is orthogonal to the merged `confidence` field on OperatorCanonicalView
 * (which blends per-ref confidence). identityConfidence only answers:
 * "could we identify this person by a stable id, or are we trusting a name?"
 */
export function getIdentityConfidence(
  view: OperatorCanonicalView
): IdentityConfidence {
  const src = getSourceIdentities(view);
  return src.hasHash || src.hasUid ? 'strong' : 'weak';
}

/**
 * Build a lookup map from canonicalOperatorKey to the operator's display +
 * linked-keys + confidence + identity signals.
 *
 * Consumers use this to map ANY operator reference (raw or canonical) to the
 * same canonical identity without re-running the canonical projection.
 */
export function buildCanonicalOperatorIndex(
  canonical: CanonicalProjection
): CanonicalOperatorIndex {
  const out: CanonicalOperatorIndex = {};
  for (const op of canonical.canonicalOperators) {
    const entry: CanonicalOperatorIndexEntry = {
      linkedKeys: [...op.linkedKeys].sort(),
      confidence: op.confidence,
      identityConfidence: getIdentityConfidence(op),
      sourceIdentities: getSourceIdentities(op),
    };
    if (op.displayName !== undefined) entry.displayName = op.displayName;
    if (op.legalName !== undefined) entry.legalName = op.legalName;
    out[op.canonicalOperatorKey] = entry;
  }
  return out;
}

/**
 * Resolve ANY operator reference (raw `op:...` / `op-uid:...` / `op-name:...`
 * or canonical key) to its canonical-operator-index entry plus the resolved
 * canonical key. Returns undefined if the reference is unknown.
 */
export function lookupCanonicalOperator(
  ref: string,
  index: CanonicalOperatorIndex
): { canonicalOperatorKey: string; entry: CanonicalOperatorIndexEntry } | undefined {
  // Direct hit when `ref` is already a canonical key.
  const direct = index[ref];
  if (direct) {
    return { canonicalOperatorKey: ref, entry: direct };
  }
  // Fallback: scan linkedKeys. O(canonical count) — fine at production
  // scale for single-lookup callers; bulk callers should reverse-index.
  for (const [canonicalOperatorKey, entry] of Object.entries(index)) {
    if (entry.linkedKeys.includes(ref)) {
      return { canonicalOperatorKey, entry };
    }
  }
  return undefined;
}
