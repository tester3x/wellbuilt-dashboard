import type { BuildTruthProjectionInput } from './buildTruthProjection';
import { buildTruthProjection } from './buildTruthProjection';
import { buildCanonicalProjection } from './buildCanonicalProjection';
import { debugTruthProjection } from './debugTruthProjection';
import { validateProjection } from './validateProjection';
import { buildCanonicalOperatorIndex } from './canonicalIdentity';
import { buildCanonicalLocationIndex } from './canonicalLocationIdentity';
import type { IntegratedTruthBundle } from './types.integration';

export interface BuildIntegratedTruthBundleOptions {
  generatedAt?: string;
}

export function buildIntegratedTruthBundle(
  input: BuildTruthProjectionInput,
  options: BuildIntegratedTruthBundleOptions = {}
): IntegratedTruthBundle {
  const truthProjection = buildTruthProjection(input);
  const canonicalProjection = buildCanonicalProjection(truthProjection);
  const validationWarnings = validateProjection(truthProjection);
  const debugReport = debugTruthProjection(truthProjection);
  const canonicalOperatorIndex = buildCanonicalOperatorIndex(canonicalProjection);
  const canonicalLocationIndex = buildCanonicalLocationIndex(canonicalProjection);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return {
    truthProjection,
    canonicalProjection,
    validationWarnings,
    debugReport,
    canonicalOperatorIndex,
    canonicalLocationIndex,
    generatedAt,
  };
}
