import { compareRawVsCanonical } from './compareRawVsCanonical';
import type {
  IntegratedTruthBundle,
  ShadowComparisonBundle,
} from './types.integration';

export interface BuildShadowComparisonBundleOptions {
  generatedAt?: string;
}

export function buildShadowComparisonBundle(
  bundle: IntegratedTruthBundle,
  options: BuildShadowComparisonBundleOptions = {}
): ShadowComparisonBundle {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const warnings = bundle.validationWarnings;
  const comparison = compareRawVsCanonical(
    bundle.truthProjection,
    bundle.canonicalProjection,
    { warnings }
  );

  const findings: string[] = [];

  findings.push(
    `operator compression ${comparison.operatorCompression.rawCount} -> ${comparison.operatorCompression.canonicalCount}`
  );
  findings.push(
    `location compression ${comparison.locationCompression.rawCount} -> ${comparison.locationCompression.canonicalCount}`
  );
  findings.push(
    `activity compression ${comparison.activityCompression.rawCount} -> ${comparison.activityCompression.canonicalCount}`
  );

  const openSessions = warnings.filter((w) => w.kind === 'session_no_end').length;
  if (openSessions > 0) {
    findings.push(`open sessions detected: ${openSessions}`);
  }

  const jsaMissingActivity = warnings.filter(
    (w) => w.kind === 'jsa_entry_no_activity'
  ).length;
  if (jsaMissingActivity > 0) {
    findings.push(
      `jsa entries missing activity binding: ${jsaMissingActivity}`
    );
  }

  const parallelOperatorIdentities = warnings.filter(
    (w) => w.kind === 'operator_parallel_identities'
  ).length;
  if (parallelOperatorIdentities > 0) {
    findings.push(
      `operator parallel identities flagged: ${parallelOperatorIdentities}`
    );
  }

  const sessionsNoOperator = warnings.filter(
    (w) => w.kind === 'session_no_operator'
  ).length;
  if (sessionsNoOperator > 0) {
    findings.push(`sessions missing operator: ${sessionsNoOperator}`);
  }

  const sessionsOverlap = warnings.filter(
    (w) => w.kind === 'session_overlap_same_operator'
  ).length;
  if (sessionsOverlap > 0) {
    findings.push(`overlapping sessions same operator: ${sessionsOverlap}`);
  }

  const eventsNoTimestamp = warnings.filter(
    (w) => w.kind === 'event_no_timestamp'
  ).length;
  if (eventsNoTimestamp > 0) {
    findings.push(`events missing timestamp: ${eventsNoTimestamp}`);
  }

  const locationAliasCollisions = warnings.filter(
    (w) => w.kind === 'location_alias_collision'
  ).length;
  if (locationAliasCollisions > 0) {
    findings.push(`location alias collisions: ${locationAliasCollisions}`);
  }

  return {
    comparison,
    warnings,
    notableFindings: findings,
    generatedAt,
  };
}
