import type { IdentitySeverity } from './types.identityHealth';

export interface SeverityInputs {
  /** True when canonicalOperatorKey starts with `op-unresolved:`. */
  isUnresolved: boolean;
  /** True when identityConfidence resolves to 'weak' (no hash, no uid). */
  isWeak: boolean;
  /** True when any linkedKey starts with `op-name:` (name-only identity slot). */
  hasNameOnlyLinkedKey: boolean;
  /** True when the operator has been merged (mergedFrom.length > 0). */
  isMerged: boolean;
  /** True when operator_parallel_identities warning applies to this operator. */
  hasParallelIdentitiesWarning: boolean;
  /** Count of linked raw operator keys (>=1). */
  linkedKeyCount: number;
  /** True when canonicalOperatorKey differs from at least one linkedKey. */
  canonicalDiffersFromRaw: boolean;
}

export interface SeverityResult {
  severity: IdentitySeverity;
  /** Factual reasons that contributed to the score, in the order observed. */
  reasons: string[];
}

/**
 * Score an operator's identity severity.
 *
 * Applied in highest-wins order so the overlap between "weak identity" and
 * "weak with name-only linkage" in the Phase 10 spec resolves deterministically:
 *
 *   HIGH
 *     · unresolved identity
 *     · parallel identities warning + linkedKeyCount > 1
 *     · weak identity with no hash, no uid, AND no name-only linkage
 *       (truly blank — only op-unresolved-like linked keys)
 *   MEDIUM
 *     · weak identity with only name-based linkage
 *     · merged identity with strong canonical but multiple linked keys
 *     · canonical differs from raw
 *   LOW
 *     · strong identity with linked aliases only
 *     · no warnings / stable identity
 *
 * Reasons are factual — no editorial language. Output is deterministic.
 */
export function scoreOperatorIdentitySeverity(
  inputs: SeverityInputs
): SeverityResult {
  const highReasons: string[] = [];
  const mediumReasons: string[] = [];
  const lowReasons: string[] = [];

  // ── HIGH ────────────────────────────────────────────────────────────────
  if (inputs.isUnresolved) {
    highReasons.push('unresolved identity');
  }
  if (inputs.hasParallelIdentitiesWarning && inputs.linkedKeyCount > 1) {
    highReasons.push('parallel identities warning with multiple linked keys');
  }
  // "Weak identity with no hash and no uid" — if also missing name-only
  // linkage, it's effectively blank and can't be looked up by any identifier.
  if (inputs.isWeak && !inputs.hasNameOnlyLinkedKey && !inputs.isUnresolved) {
    highReasons.push('no hash, no uid, and no name-only identity observed');
  }

  // ── MEDIUM ──────────────────────────────────────────────────────────────
  if (inputs.isWeak && inputs.hasNameOnlyLinkedKey && !inputs.isUnresolved) {
    mediumReasons.push('name-only identity');
  }
  if (!inputs.isWeak && inputs.isMerged && inputs.linkedKeyCount > 1) {
    mediumReasons.push('multiple linked identities (strong canonical)');
  }
  if (inputs.canonicalDiffersFromRaw) {
    mediumReasons.push('canonical key differs from one or more raw keys');
  }

  // ── LOW ─────────────────────────────────────────────────────────────────
  if (
    !inputs.isWeak &&
    !inputs.isUnresolved &&
    !inputs.hasParallelIdentitiesWarning &&
    inputs.linkedKeyCount === 1
  ) {
    lowReasons.push('stable strong identity, single linked key');
  } else if (
    !inputs.isWeak &&
    !inputs.isUnresolved &&
    !inputs.hasParallelIdentitiesWarning &&
    inputs.isMerged &&
    inputs.linkedKeyCount > 1
  ) {
    lowReasons.push('strong identity with linked aliases only');
  }

  if (highReasons.length > 0) {
    return { severity: 'high', reasons: highReasons };
  }
  if (mediumReasons.length > 0) {
    return { severity: 'medium', reasons: mediumReasons };
  }
  if (lowReasons.length > 0) {
    return { severity: 'low', reasons: lowReasons };
  }
  return { severity: 'low', reasons: ['stable identity'] };
}
