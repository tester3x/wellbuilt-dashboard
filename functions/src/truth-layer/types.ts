export type SourceSystem =
  | 'wbm'
  | 'wbt'
  | 'wbs'
  | 'wbjsa'
  | 'dashboard'
  | 'rtdb'
  | 'firestore'
  | 'cloud_function'
  | 'async_storage'
  | 'unknown';

export interface SourceRef {
  system: SourceSystem;
  path?: string;
  field?: string;
  recordId?: string;
  note?: string;
}

export interface OperatorRef {
  operatorKey: string;
  hash?: string;
  driverId?: string;
  uid?: string;
  displayName?: string;
  legalName?: string;
  companyId?: string;
  companyName?: string;
  sourceRefs: SourceRef[];
  confidence?: 'strong' | 'medium' | 'weak';
}

export interface Session {
  sessionKey: string;
  operatorKey?: string;
  startedAt?: string;
  endedAt?: string;
  timezoneMode: 'local' | 'utc' | 'mixed' | 'unknown';
  evidence: Array<'shift_doc' | 'invoice_timeline' | 'dispatch' | 'jsa' | 'inferred'>;
  sourceRefs: SourceRef[];
  isOpen?: boolean;
  durationConfidence?: 'exact' | 'partial' | 'unknown';
}

export interface ReportingWindow {
  windowKey: string;
  kind: 'local_day' | 'utc_day' | 'production_day_6am' | 'payroll_week' | 'custom';
  startsAt: string;
  endsAt: string;
  timezone: string;
  boundaryRule?: string;
  sourceRefs: SourceRef[];
}

export interface LocationRef {
  locationKey: string;
  preferredName: string;
  aliases: string[];
  officialName?: string;
  ndicName?: string;
  apiNo?: string;
  kind?: 'well' | 'disposal' | 'yard' | 'pad' | 'custom' | 'unknown';
  operator?: string;
  county?: string;
  lat?: number;
  lng?: number;
  sourceRefs: SourceRef[];
  confidence?: 'strong' | 'medium' | 'weak';
}

export interface ActivityRef {
  activityKey: string;
  canonicalLabel: string;
  family?: 'transport' | 'service' | 'safety' | 'compliance' | 'admin' | 'unknown';
  rawLabels: Array<{
    value: string;
    field: string;
    system?: SourceSystem;
  }>;
  sourceRefs: SourceRef[];
  confidence?: 'strong' | 'medium' | 'weak';
}

export interface JSAEntryView {
  entryKey: string;
  name: string;
  normalizedName: string;
  kind: 'well' | 'location' | 'stamp' | 'legacy' | 'unknown';
  pickupDropoffType?: 'pickup' | 'dropoff';
  activityLabel?: string;
  stampedAt?: string;
  dispatchId?: string;
  operator?: string;
  county?: string;
  sourceRefs: SourceRef[];
  hasActivityBinding?: boolean;
}

export interface JSAView {
  jsaKey: string;
  operatorKey?: string;
  sessionKey?: string;
  localDate?: string;
  utcDate?: string;
  completed?: boolean;
  pdfUrl?: string;
  signatureName?: string;
  signatureImagePresent?: boolean;
  entries: JSAEntryView[];
  sourceRefs: SourceRef[];
}

export interface OperationalEvent {
  eventKey: string;
  eventType:
    | 'login'
    | 'logout'
    | 'arrival'
    | 'departure'
    | 'pickup'
    | 'dropoff'
    | 'jsa_completed'
    | 'location_stamped'
    | 'production_recorded'
    | 'dispatch_status'
    | 'unknown';
  occurredAt?: string;
  operatorKey?: string;
  sessionKey?: string;
  locationKey?: string;
  activityKey?: string;
  relatedRecordId?: string;
  payload?: Record<string, unknown>;
  sourceRefs: SourceRef[];
}

export interface TruthProjection {
  operators: OperatorRef[];
  sessions: Session[];
  reportingWindows: ReportingWindow[];
  locations: LocationRef[];
  activities: ActivityRef[];
  jsaViews: JSAView[];
  events: OperationalEvent[];
}
