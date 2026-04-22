import type { ActivityRef, LocationRef, SourceRef } from './types';

export interface OperatorCanonicalView {
  canonicalOperatorKey: string;
  hash?: string;
  uid?: string;
  displayName?: string;
  legalName?: string;
  companyId?: string;
  companyName?: string;
  linkedKeys: string[];
  mergedFrom: string[];
  confidence: 'strong' | 'medium' | 'weak';
  sourceRefs: SourceRef[];
}

export interface LocationCanonicalView {
  canonicalLocationKey: string;
  preferredName: string;
  aliases: string[];
  kind?: LocationRef['kind'];
  operator?: string;
  county?: string;
  apiNo?: string;
  officialName?: string;
  ndicName?: string;
  lat?: number;
  lng?: number;
  linkedKeys: string[];
  mergedFrom: string[];
  confidence: 'strong' | 'medium' | 'weak';
  sourceRefs: SourceRef[];
}

export interface ActivityCanonicalView {
  canonicalActivityKey: string;
  canonicalLabel: string;
  family?: ActivityRef['family'];
  rawLabels: ActivityRef['rawLabels'];
  linkedKeys: string[];
  mergedFrom: string[];
  confidence: 'strong' | 'medium' | 'weak';
  sourceRefs: SourceRef[];
}

export interface CanonicalProjection {
  canonicalOperators: OperatorCanonicalView[];
  canonicalLocations: LocationCanonicalView[];
  canonicalActivities: ActivityCanonicalView[];
}
