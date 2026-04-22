import type {
  IdentityHealthDashboardSummary,
  IdentityHealthView,
  IdentityHeadlineStatus,
  IdentityIssueGroup,
  IdentitySeverity,
  OperatorIdentityDiagnostic,
  TopRiskyOperator,
} from './types.identityHealth';

const SEVERITY_RANK: Record<IdentitySeverity, number> = {
  high: 2,
  medium: 1,
  low: 0,
};

const DEFAULT_TOP_RISKY_LIMIT = 10;

/**
 * Headline status rules — deterministic, documented:
 *
 *   risky   — any unresolvedCount > 0  OR  highSeverityCount >= 3
 *   watch   — highSeverityCount > 0    OR  mediumSeverityCount > 0
 *   healthy — no high, no medium severity
 */
function deriveHeadlineStatus(
  view: IdentityHealthView
): IdentityHeadlineStatus {
  const s = view.summary;
  if (s.unresolvedCount > 0 || s.highSeverityCount >= 3) return 'risky';
  if (s.highSeverityCount > 0 || s.mediumSeverityCount > 0) return 'watch';
  return 'healthy';
}

/** Retain only issue groups that actually have members. */
function topIssueGroups(
  groups: IdentityIssueGroup[]
): IdentityIssueGroup[] {
  return groups
    .filter((g) => g.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.kind.localeCompare(b.kind);
    });
}

/** Top risky operators, ordered by severity desc then reason-count desc then key. */
function topRiskyOperators(
  diagnostics: OperatorIdentityDiagnostic[],
  limit: number
): TopRiskyOperator[] {
  const ranked = [...diagnostics]
    .filter((d) => d.severity !== 'low')
    .sort((a, b) => {
      const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sev !== 0) return sev;
      const r = b.reasons.length - a.reasons.length;
      if (r !== 0) return r;
      return a.canonicalOperatorKey.localeCompare(b.canonicalOperatorKey);
    })
    .slice(0, limit);
  return ranked.map((d) => {
    const item: TopRiskyOperator = {
      canonicalOperatorKey: d.canonicalOperatorKey,
      severity: d.severity,
      reasons: [...d.reasons],
    };
    if (d.displayName !== undefined) item.displayName = d.displayName;
    return item;
  });
}

export interface BuildIdentityHealthDashboardSummaryOptions {
  topRiskyLimit?: number;
}

/**
 * Lean admin-facing surface adapter. Derived from the full IdentityHealthView,
 * never recomputed from scratch. No UI code — data only.
 */
export function buildIdentityHealthDashboardSummary(
  view: IdentityHealthView,
  options: BuildIdentityHealthDashboardSummaryOptions = {}
): IdentityHealthDashboardSummary {
  const limit = options.topRiskyLimit ?? DEFAULT_TOP_RISKY_LIMIT;
  return {
    headlineStatus: deriveHeadlineStatus(view),
    summary: view.summary,
    topIssueGroups: topIssueGroups(view.issueGroups),
    topRiskyOperators: topRiskyOperators(view.diagnostics, limit),
    generatedAt: view.generatedAt,
  };
}
