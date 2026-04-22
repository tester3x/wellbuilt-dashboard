import { buildCanonicalDashboardView } from './buildCanonicalDashboardView';
import { buildRawDashboardView } from './buildRawDashboardView';
import { compareRawVsCanonical } from './compareRawVsCanonical';
import type { IntegratedTruthBundle, DashboardReadModel } from './types.integration';

export interface BuildDashboardReadModelOptions {
  generatedAt?: string;
}

export function buildDashboardReadModel(
  bundle: IntegratedTruthBundle,
  options: BuildDashboardReadModelOptions = {}
): DashboardReadModel {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const warnings = bundle.validationWarnings;

  const dashboardView = buildRawDashboardView(bundle.truthProjection, {
    warnings,
    generatedAt,
  });

  const canonicalDashboardView = buildCanonicalDashboardView(
    bundle.truthProjection,
    bundle.canonicalProjection,
    { warnings, generatedAt }
  );

  const comparison = compareRawVsCanonical(
    bundle.truthProjection,
    bundle.canonicalProjection,
    { warnings }
  );

  return {
    dashboardView,
    canonicalDashboardView,
    comparison,
    warnings,
    generatedAt,
  };
}
