import type {
  IdentityHealthDashboardSummary,
  IdentityHealthSnapshot,
  IdentityHealthView,
} from './types.identityHealth';

export interface BuildIdentityHealthSnapshotOptions {
  date?: string;
  topRiskyLimit?: number;
}

const DEFAULT_TOP_RISKY_LIMIT = 10;

/**
 * Deterministic, serializable snapshot suitable for future history / trending.
 * Phase 10 does NOT persist this anywhere — this is prep-only.
 *
 * Pulls `topRiskyOperatorKeys` straight from the same ranking the dashboard
 * summary uses, so on-screen state and snapshot state stay in sync.
 */
export function buildIdentityHealthSnapshot(
  view: IdentityHealthView,
  dashboard: IdentityHealthDashboardSummary,
  options: BuildIdentityHealthSnapshotOptions = {}
): IdentityHealthSnapshot {
  const limit = options.topRiskyLimit ?? DEFAULT_TOP_RISKY_LIMIT;
  const topRiskyOperatorKeys = dashboard.topRiskyOperators
    .slice(0, limit)
    .map((t) => t.canonicalOperatorKey);

  const out: IdentityHealthSnapshot = {
    generatedAt: view.generatedAt,
    summary: view.summary,
    issueGroups: view.issueGroups,
    topRiskyOperatorKeys,
  };
  if (options.date !== undefined) out.date = options.date;
  return out;
}
