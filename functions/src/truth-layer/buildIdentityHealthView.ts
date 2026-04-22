import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import type { ValidationWarning } from './validateProjection';
import type {
  IdentityHealthSummary,
  IdentityHealthView,
  IdentityIssueGroup,
  IdentityIssueKind,
  OperatorIdentityDiagnostic,
} from './types.identityHealth';
import { buildOperatorIdentityDiagnostics } from './buildOperatorIdentityDiagnostics';
import { validateProjection } from './validateProjection';

const ALL_ISSUE_KINDS: IdentityIssueKind[] = [
  'weak_identity',
  'parallel_identity',
  'merged_identity',
  'unresolved_identity',
];

function summarize(
  diagnostics: OperatorIdentityDiagnostic[]
): IdentityHealthSummary {
  const s: IdentityHealthSummary = {
    totalCanonicalOperators: diagnostics.length,
    strongCount: 0,
    weakCount: 0,
    mergedCount: 0,
    parallelIdentityCount: 0,
    unresolvedCount: 0,
    highSeverityCount: 0,
    mediumSeverityCount: 0,
    lowSeverityCount: 0,
  };
  for (const d of diagnostics) {
    if (d.identityConfidence === 'strong') s.strongCount += 1;
    else s.weakCount += 1;
    if (d.isMergedIdentity) s.mergedCount += 1;
    if (d.hasParallelIdentities) s.parallelIdentityCount += 1;
    if (d.isUnresolved) s.unresolvedCount += 1;
    if (d.severity === 'high') s.highSeverityCount += 1;
    else if (d.severity === 'medium') s.mediumSeverityCount += 1;
    else s.lowSeverityCount += 1;
  }
  return s;
}

function groupIssues(
  diagnostics: OperatorIdentityDiagnostic[]
): IdentityIssueGroup[] {
  const buckets: Record<IdentityIssueKind, string[]> = {
    weak_identity: [],
    parallel_identity: [],
    merged_identity: [],
    unresolved_identity: [],
  };
  for (const d of diagnostics) {
    if (d.identityConfidence === 'weak') {
      buckets.weak_identity.push(d.canonicalOperatorKey);
    }
    if (d.hasParallelIdentities) {
      buckets.parallel_identity.push(d.canonicalOperatorKey);
    }
    if (d.isMergedIdentity) {
      buckets.merged_identity.push(d.canonicalOperatorKey);
    }
    if (d.isUnresolved) {
      buckets.unresolved_identity.push(d.canonicalOperatorKey);
    }
  }
  return ALL_ISSUE_KINDS.map((kind) => {
    const operatorKeys = [...buckets[kind]].sort();
    return { kind, count: operatorKeys.length, operatorKeys };
  });
}

export interface BuildIdentityHealthViewOptions {
  warnings?: ValidationWarning[];
  generatedAt?: string;
}

/**
 * Compose OperatorIdentityDiagnostic[] + summary + issue groups.
 * Pure and deterministic given fixed generatedAt.
 */
export function buildIdentityHealthView(
  projection: TruthProjection,
  canonical: CanonicalProjection,
  options: BuildIdentityHealthViewOptions = {}
): IdentityHealthView {
  const warnings = options.warnings ?? validateProjection(projection);
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const diagnostics = buildOperatorIdentityDiagnostics(
    projection,
    canonical,
    warnings
  );
  const summary = summarize(diagnostics);
  const issueGroups = groupIssues(diagnostics);

  return { summary, issueGroups, diagnostics, generatedAt };
}
