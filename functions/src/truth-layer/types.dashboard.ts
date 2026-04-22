import type { SourceRef } from './types';
import type { ValidationWarning } from './validateProjection';

export interface CanonicalOperatorSummary {
  canonicalOperatorKey: string;
  preferredDisplayName: string;
  linkedKeys: string[];
  confidence: 'strong' | 'medium' | 'weak';
  sessionCount: number;
  openSessionCount: number;
  locationsVisited: string[];
  activitiesPerformed: string[];
  jsaCompletedCount: number;
  totalEventCount: number;
  totalActiveMinutes: number;
  warnings: ValidationWarning[];
}

export interface CanonicalLocationSummary {
  canonicalLocationKey: string;
  preferredName: string;
  aliases: string[];
  kind?: 'well' | 'disposal' | 'yard' | 'pad' | 'custom' | 'unknown';
  confidence: 'strong' | 'medium' | 'weak';
  operatorNames: string[];
  activityLabels: string[];
  visitCount: number;
  eventCount: number;
  jsaEntryCount: number;
  warnings: ValidationWarning[];
}

export interface CanonicalActivitySummary {
  canonicalActivityKey: string;
  canonicalLabel: string;
  family?: 'transport' | 'service' | 'safety' | 'compliance' | 'admin' | 'unknown';
  rawLabels: string[];
  operatorNames: string[];
  locationNames: string[];
  eventCount: number;
  jsaEntryCount: number;
  warnings: ValidationWarning[];
}

export interface CanonicalDashboardView {
  operators: CanonicalOperatorSummary[];
  locations: CanonicalLocationSummary[];
  activities: CanonicalActivitySummary[];
  warnings: ValidationWarning[];
  generatedAt: string;
}

export interface CanonicalRAGRecordMetadata {
  type:
    | 'event'
    | 'jsa_entry'
    | 'session'
    | 'canonical_operator_summary'
    | 'canonical_location_summary'
    | 'canonical_activity_summary';
  canonicalOperatorKey?: string;
  canonicalLocationKey?: string;
  canonicalActivityKey?: string;
  rawOperatorKey?: string;
  rawLocationKey?: string;
  rawActivityKey?: string;
  sessionKey?: string;
  timestamp?: string;
  confidence?: string;
  // Phase 9 — canonical operator identity surfaced in per-record metadata.
  // Present only when resolvable; never inferred when absent.
  operatorDisplayName?: string;
  operatorConfidence?: 'strong' | 'weak';
  // Phase 11 — canonical location identity surfaced in per-record metadata.
  // Present only when resolvable. Custom/fallback locations surface as
  // locationConfidence='weak' with locationKind preserved — never as errors.
  locationDisplayName?: string;
  locationConfidence?: 'strong' | 'medium' | 'weak';
  locationKind?: 'well' | 'disposal' | 'yard' | 'pad' | 'custom' | 'unknown';
}

export interface CanonicalRAGRecord {
  text: string;
  metadata: CanonicalRAGRecordMetadata;
}

export interface CompressionGroup {
  canonicalKey: string;
  canonicalLabel: string;
  rawKeys: string[];
  mergedFrom: string[];
  confidence: 'strong' | 'medium' | 'weak';
}

export interface RawVsCanonicalComparison {
  operatorCompression: {
    rawCount: number;
    canonicalCount: number;
    groups: CompressionGroup[];
  };
  locationCompression: {
    rawCount: number;
    canonicalCount: number;
    groups: CompressionGroup[];
  };
  activityCompression: {
    rawCount: number;
    canonicalCount: number;
    groups: CompressionGroup[];
  };
  unresolvedWarnings: ValidationWarning[];
}

export type { SourceRef };
