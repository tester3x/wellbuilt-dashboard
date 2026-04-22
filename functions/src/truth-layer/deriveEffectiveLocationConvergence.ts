import type {
  LocationConvergencePreview,
  LocationEffectiveConvergence,
  LocationReviewDisposition,
} from './types.locationHealth';

function truthyTrimmed(v: string | undefined | null): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export interface EffectiveLocationConvergenceInput {
  reviewDisposition: LocationReviewDisposition;
  canonicalLocationKey?: string;
  preferredName?: string;
  convergencePreview?: LocationConvergencePreview;
  // Defensive fields — spec §3/§4 list these in the priority chain but
  // they don't live on LocationIdentityDiagnostic today. Accepted so the
  // helper can be called from other contexts (e.g. RAG-side consumers
  // later) without losing the documented priority ordering. Never invented.
  rawLocationKey?: string;
  locationDisplayName?: string;
}

/**
 * Phase 16 — derive a read-only "effective identity" for approved locations.
 * NEVER rewrites source truth. NEVER invents keys or names. NEVER persists.
 *
 * Gating (spec §2):
 *   - reviewDisposition must be 'approved' — strict, no exceptions.
 *
 * effectiveLocationKey priority (spec §3):
 *   1. canonicalLocationKey if present
 *   2. rawLocationKey as a defensive fallback
 *   3. otherwise no block (don't fabricate)
 *
 * effectiveDisplayName priority (spec §4):
 *   1. convergencePreview.unifiedDisplayName if present
 *   2. locationDisplayName (if passed in) if present
 *   3. preferredName if present
 *   4. otherwise no block
 *
 * sourceCanonicalLocationKey (spec §5): must be the exact canonicalLocationKey.
 * If canonicalLocationKey is absent, omit the whole block rather than
 * fabricating a source — spec's conservative stance. This makes the
 * "canonical absent / rawLocationKey present" path unreachable in practice,
 * which is the intended behavior: no source-of-truth → no effective block.
 */
export function deriveEffectiveLocationConvergence(
  input: EffectiveLocationConvergenceInput
): LocationEffectiveConvergence | undefined {
  if (input.reviewDisposition !== 'approved') return undefined;

  const canonical = truthyTrimmed(input.canonicalLocationKey);
  // Spec §5 — sourceCanonicalLocationKey must be truthfully set. No
  // canonical → omit whole block. This dominates the effectiveLocationKey
  // priority-2 fallback on purpose.
  if (canonical === undefined) return undefined;

  const effectiveLocationKey =
    canonical ?? truthyTrimmed(input.rawLocationKey);
  if (effectiveLocationKey === undefined) return undefined;

  const effectiveDisplayName =
    truthyTrimmed(input.convergencePreview?.unifiedDisplayName) ??
    truthyTrimmed(input.locationDisplayName) ??
    truthyTrimmed(input.preferredName);
  if (effectiveDisplayName === undefined) return undefined;

  return {
    effectiveLocationKey,
    effectiveDisplayName,
    appliedByRule: 'approved_review',
    sourceCanonicalLocationKey: canonical,
  };
}
