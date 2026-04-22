import type { LocationRef } from './types';
import type {
  LocationConvergenceDisposition,
  LocationTrustLevel,
} from './types.locationHealth';

// Phase 13 — local threshold. Kept inline (not exported) on purpose.
// Alias-conflict count strictly greater than this lands in EXCLUDE. Anything
// at-or-below still flows through the HOLD rules. Chosen per spec §3.A.
const LARGE_ALIAS_GROUP = 6;

// Operational kinds — when none of NDIC/SWD/well_config backs the location,
// these are treated as "this is a real place but not a canonical identity"
// and excluded from the convergence review queue. Do NOT add 'well' or
// 'disposal' here; those come from official catalogs.
const OPERATIONAL_KINDS: ReadonlyArray<NonNullable<LocationRef['kind']>> = [
  'custom',
  'pad',
  'yard',
  'unknown',
];

function isOperationalKind(kind: LocationRef['kind'] | undefined): boolean {
  if (kind === undefined) return false;
  return OPERATIONAL_KINDS.includes(kind);
}

/**
 * Phase 13 — very light alias normalization. Counting only; never used to
 * rewrite, merge, or match aliases for behavior. Rules from spec §2:
 *   - lowercase
 *   - trim
 *   - collapse internal whitespace
 * Punctuation and numbers are PRESERVED — "atlas-1" and "atlas 1" remain
 * distinct strings, matching Phase 12 drift-detection semantics.
 */
export function lightNormalizeAliasForDiversity(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Phase 13 — compute aliasDiversity: the distinct count of aliases after
 * light normalization. Empty aliases collapse out. Diagnostics only.
 */
export function computeAliasDiversity(aliases: ReadonlyArray<string>): number {
  const seen = new Set<string>();
  for (const a of aliases) {
    const n = lightNormalizeAliasForDiversity(a);
    if (n.length > 0) seen.add(n);
  }
  return seen.size;
}

export interface ConvergenceDispositionInput {
  hasOfficialBacking: boolean;
  isFallbackOnly: boolean;
  kind?: LocationRef['kind'];
  locationTrustLevel: LocationTrustLevel;
  potentialDrift: boolean;
  isStableIdentity: boolean;
  aliasConflictCount: number;
  hasMixedSourceKinds: boolean;
}

export interface ConvergenceDispositionResult {
  disposition: LocationConvergenceDisposition;
  reasons: string[];
}

/**
 * Phase 13 — classify a canonical location for the convergence review queue.
 * Pure + deterministic. Input is the Phase 11/12 derived facts; output is a
 * disposition bucket plus factual reasons.
 *
 * Rule order (spec §3): EXCLUDE first, then HOLD, then CANDIDATE. Candidate
 * requires ALL guardrails to pass — intentionally strict. Custom / pad /
 * yard / fallback locations stay protected: they're never downgraded or
 * hidden, just flagged "exclude" for this review queue.
 *
 * Reasons are drawn from the short factual vocabulary in spec §4. Order is
 * deterministic (checks fire top-to-bottom).
 */
export function deriveLocationConvergenceDisposition(
  input: ConvergenceDispositionInput
): ConvergenceDispositionResult {
  const reasons: string[] = [];

  // --- A) EXCLUDE ----------------------------------------------------------
  if (input.isFallbackOnly) {
    reasons.push('fallback-only location');
  }
  // Operational kind without official backing. Skip the reason if
  // "fallback-only" already covered it — same root cause, less noise.
  if (
    !input.hasOfficialBacking &&
    isOperationalKind(input.kind) &&
    !input.isFallbackOnly
  ) {
    reasons.push('custom operational location without official backing');
  }
  if (input.locationTrustLevel === 'low') {
    reasons.push('low trust identity');
  }
  if (input.potentialDrift) {
    reasons.push('potential drift detected');
  }
  if (input.aliasConflictCount > LARGE_ALIAS_GROUP) {
    reasons.push('large alias group');
  }
  if (reasons.length > 0) {
    return { disposition: 'exclude', reasons };
  }

  // --- B) HOLD -------------------------------------------------------------
  if (input.locationTrustLevel === 'moderate') {
    reasons.push('moderate trust identity');
  }
  if (input.aliasConflictCount > 0) {
    reasons.push('aliases present');
  }
  if (input.hasMixedSourceKinds) {
    reasons.push('mixed source kinds');
  }
  if (
    input.hasOfficialBacking &&
    !input.isStableIdentity &&
    reasons.length === 0
  ) {
    reasons.push('official-backed but not clean enough for candidate');
  }
  if (reasons.length > 0) {
    return { disposition: 'hold', reasons };
  }

  // --- C) CANDIDATE --------------------------------------------------------
  if (
    input.hasOfficialBacking &&
    input.locationTrustLevel === 'high' &&
    input.isStableIdentity &&
    input.aliasConflictCount === 0 &&
    !input.potentialDrift &&
    !input.isFallbackOnly
  ) {
    return {
      disposition: 'candidate',
      reasons: ['official-backed location', 'stable identity', 'high trust'],
    };
  }

  // --- Defensive fallthrough ----------------------------------------------
  // Unreachable under current Phase 11/12 rules (high trust implies official
  // backing), but kept so future derivations can evolve without producing an
  // untyped result. Hold with an explicit human-review reason.
  return { disposition: 'hold', reasons: ['requires human review'] };
}
