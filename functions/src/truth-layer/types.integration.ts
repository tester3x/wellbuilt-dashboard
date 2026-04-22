import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import type { DebugReport } from './debugTruthProjection';
import type { ValidationWarning } from './validateProjection';
import type {
  CanonicalDashboardView,
  CanonicalRAGRecord,
  RawVsCanonicalComparison,
} from './types.dashboard';
import type { RAGRecord } from './buildRAGRecords';
import type { RawDashboardView } from './buildRawDashboardView';
import type { CanonicalOperatorIndex } from './canonicalIdentity';
import type { CanonicalLocationIndex } from './canonicalLocationIdentity';

export interface IntegratedTruthBundle {
  truthProjection: TruthProjection;
  canonicalProjection: CanonicalProjection;
  validationWarnings: ValidationWarning[];
  debugReport: DebugReport;
  canonicalOperatorIndex: CanonicalOperatorIndex;
  canonicalLocationIndex: CanonicalLocationIndex;
  generatedAt: string;
}

export interface DashboardReadModel {
  dashboardView: RawDashboardView;
  canonicalDashboardView: CanonicalDashboardView;
  comparison: RawVsCanonicalComparison;
  warnings: ValidationWarning[];
  generatedAt: string;
}

export interface RAGIngestBundleStats {
  rawCount: number;
  canonicalCount: number;
  eventCount: number;
  jsaRecordCount: number;
  sessionRecordCount: number;
  summaryRecordCount: number;
}

export interface RAGIngestBundle {
  rawRagRecords: RAGRecord[];
  canonicalRagRecords: CanonicalRAGRecord[];
  warnings: ValidationWarning[];
  generatedAt: string;
  stats: RAGIngestBundleStats;
}

export interface ShadowComparisonBundle {
  comparison: RawVsCanonicalComparison;
  warnings: ValidationWarning[];
  notableFindings: string[];
  generatedAt: string;
}
