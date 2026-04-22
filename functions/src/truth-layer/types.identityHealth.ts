import type { SourceIdentities } from './canonicalIdentity';

export type IdentitySeverity = 'low' | 'medium' | 'high';

export type IdentityHeadlineStatus = 'healthy' | 'watch' | 'risky';

export type IdentityIssueKind =
  | 'weak_identity'
  | 'parallel_identity'
  | 'merged_identity'
  | 'unresolved_identity';

export interface OperatorIdentityDiagnostic {
  canonicalOperatorKey: string;
  displayName?: string;
  linkedKeys: string[];
  linkedKeyCount: number;
  identityConfidence: 'strong' | 'weak';
  sourceIdentities: SourceIdentities;
  warningKinds: string[];
  severity: IdentitySeverity;
  reasons: string[];
  rawOperatorKeys: string[];
  legacyIdentifiers?: string[];
  hasParallelIdentities: boolean;
  isMergedIdentity: boolean;
  isUnresolved: boolean;
}

export interface IdentityHealthSummary {
  totalCanonicalOperators: number;
  strongCount: number;
  weakCount: number;
  mergedCount: number;
  parallelIdentityCount: number;
  unresolvedCount: number;
  highSeverityCount: number;
  mediumSeverityCount: number;
  lowSeverityCount: number;
}

export interface IdentityIssueGroup {
  kind: IdentityIssueKind;
  count: number;
  operatorKeys: string[];
}

export interface IdentityHealthView {
  summary: IdentityHealthSummary;
  issueGroups: IdentityIssueGroup[];
  diagnostics: OperatorIdentityDiagnostic[];
  generatedAt: string;
}

export interface TopRiskyOperator {
  canonicalOperatorKey: string;
  displayName?: string;
  severity: IdentitySeverity;
  reasons: string[];
}

export interface IdentityHealthDashboardSummary {
  headlineStatus: IdentityHeadlineStatus;
  summary: IdentityHealthSummary;
  topIssueGroups: IdentityIssueGroup[];
  topRiskyOperators: TopRiskyOperator[];
  generatedAt: string;
}

export interface IdentityHealthSnapshot {
  date?: string;
  generatedAt: string;
  summary: IdentityHealthSummary;
  issueGroups: IdentityIssueGroup[];
  topRiskyOperatorKeys: string[];
}
