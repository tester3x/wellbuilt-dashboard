import type { CanonicalProjection } from './types.canonical';
import type {
  LocationHealthSummary,
  LocationHealthView,
  LocationIdentityDiagnostic,
  LocationManualApproval,
} from './types.locationHealth';
import { buildLocationIdentityDiagnostics } from './buildLocationIdentityDiagnostics';

function summarize(
  diagnostics: LocationIdentityDiagnostic[]
): LocationHealthSummary {
  const s: LocationHealthSummary = {
    totalCanonicalLocations: diagnostics.length,
    strongCount: 0,
    mediumCount: 0,
    weakCount: 0,
    customOnlyCount: 0,
    officialBackedCount: 0,
    mergedAliasCount: 0,
  };
  for (const d of diagnostics) {
    if (d.confidence === 'strong') s.strongCount += 1;
    else if (d.confidence === 'medium') s.mediumCount += 1;
    else s.weakCount += 1;
    if (d.isCustomOnly) s.customOnlyCount += 1;
    if (d.isOfficialBacked) s.officialBackedCount += 1;
    if (d.isMergedAliasSet) s.mergedAliasCount += 1;
  }
  return s;
}

export interface BuildLocationHealthViewOptions {
  generatedAt?: string;
  /**
   * Phase 17 — persisted admin approvals to fold into the derived review
   * pipeline. Built once by the caller from the RTDB store; passed here
   * as a map keyed by canonicalLocationKey for O(1) diagnostic lookup.
   */
  manualApprovalsByKey?: Record<string, LocationManualApproval>;
}

/**
 * Lightweight location-health composer (visibility only — no severity scoring).
 * Pure and deterministic given fixed generatedAt + approvals.
 */
export function buildLocationHealthView(
  canonical: CanonicalProjection,
  options: BuildLocationHealthViewOptions = {}
): LocationHealthView {
  const diagnostics = buildLocationIdentityDiagnostics(canonical, {
    manualApprovalsByKey: options.manualApprovalsByKey,
  });
  const summary = summarize(diagnostics);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return { summary, diagnostics, generatedAt };
}
