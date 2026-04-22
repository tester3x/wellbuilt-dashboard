import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import type { CanonicalDashboardView } from './types.dashboard';
import type { ValidationWarning } from './validateProjection';
import { validateProjection } from './validateProjection';
import { buildCanonicalOperatorSummary } from './buildCanonicalOperatorSummary';
import { buildCanonicalLocationSummary } from './buildCanonicalLocationSummary';
import { buildCanonicalActivitySummary } from './buildCanonicalActivitySummary';

export interface BuildCanonicalDashboardViewOptions {
  warnings?: ValidationWarning[];
  generatedAt?: string;
}

export function buildCanonicalDashboardView(
  projection: TruthProjection,
  canonical: CanonicalProjection,
  options: BuildCanonicalDashboardViewOptions = {}
): CanonicalDashboardView {
  const warnings = options.warnings ?? validateProjection(projection);
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  return {
    operators: buildCanonicalOperatorSummary(projection, canonical, warnings),
    locations: buildCanonicalLocationSummary(projection, canonical, warnings),
    activities: buildCanonicalActivitySummary(projection, canonical, warnings),
    warnings,
    generatedAt,
  };
}
