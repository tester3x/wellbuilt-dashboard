export * from './types';
export {
  normalizeName,
  normalizePersonName,
  resolveOperatorRef,
  mergeOperatorRefs,
} from './normalizeOperator';
export type { OperatorResolveContext } from './normalizeOperator';
export {
  normalizeLocationName,
  resolveLocationRef,
  mergeLocationRefs,
} from './normalizeLocation';
export type {
  LocationCatalog,
  LocationResolveInput,
  NdicEntry,
  SwdEntry,
  WellConfigEntry,
} from './normalizeLocation';
export {
  toCanonicalActivityLabel,
  resolveActivityRef,
  mergeActivityRefs,
} from './normalizeActivity';
export type { ActivityResolveInput } from './normalizeActivity';
export { buildSessionView } from './buildSessionView';
export type {
  BuildSessionInput,
  ShiftDocInput,
  ShiftEventInput,
} from './buildSessionView';
export { buildReportingWindows } from './buildReportingWindows';
export type { BuildReportingWindowsInput } from './buildReportingWindows';
export { buildJSAView } from './buildJSAView';
export type {
  BuildJSAViewInput,
  JSALocationInput,
  JSALocationStampInputEntry,
  JSAWellInputEntry,
} from './buildJSAView';
export { extractOperationalEvents } from './extractOperationalEvents';
export type {
  DispatchInput,
  ExtractEventsInput,
  InvoiceInput,
  InvoiceTimelineEvent,
  ProductionInput,
} from './extractOperationalEvents';
export { buildTruthProjection } from './buildTruthProjection';
export type { BuildTruthProjectionInput } from './buildTruthProjection';
export { debugTruthProjection, formatDebugReport } from './debugTruthProjection';
export type { DebugReport } from './debugTruthProjection';
export {
  validateProjection,
  groupWarningsByKind,
} from './validateProjection';
export type {
  ValidationWarning,
  ValidationWarningKind,
} from './validateProjection';
export { buildDriverDaySummaryFromTruth } from './buildDriverDaySummaryFromTruth';
export type {
  DriverDaySummary,
  DaySummarySession,
  DaySummaryLocation,
  DaySummaryActivity,
  DaySummaryJsa,
} from './buildDriverDaySummaryFromTruth';
export { buildDriverWeekSummary } from './buildDriverWeekSummary';
export type {
  DriverWeekSummary,
  BuildDriverWeekSummaryInput,
  WeekDayInput,
  WeekSummaryOperator,
  WeekSummaryTotals,
  WeekSummaryPerDay,
  WeekSummaryLocation,
  WeekSummaryActivity,
  WeekSummaryTicket,
  WeekSummaryWarning,
} from './buildDriverWeekSummary';
export { buildRAGRecords } from './buildRAGRecords';
export type { RAGRecord, RAGRecordMetadata } from './buildRAGRecords';
export { resolveCanonicalOperatorKey } from './resolveCanonicalOperatorKey';
export { resolveCanonicalLocationKey } from './resolveCanonicalLocationKey';
export { resolveCanonicalActivity } from './resolveCanonicalActivity';
export { buildCanonicalProjection } from './buildCanonicalProjection';
export type {
  OperatorCanonicalView,
  LocationCanonicalView,
  ActivityCanonicalView,
  CanonicalProjection,
} from './types.canonical';
export { buildCanonicalOperatorSummary } from './buildCanonicalOperatorSummary';
export { buildCanonicalLocationSummary } from './buildCanonicalLocationSummary';
export { buildCanonicalActivitySummary } from './buildCanonicalActivitySummary';
export { buildCanonicalDashboardView } from './buildCanonicalDashboardView';
export type { BuildCanonicalDashboardViewOptions } from './buildCanonicalDashboardView';
export { buildCanonicalRAGRecords } from './buildCanonicalRAGRecords';
export { compareRawVsCanonical } from './compareRawVsCanonical';
export type { CompareRawVsCanonicalOptions } from './compareRawVsCanonical';
export type {
  CanonicalOperatorSummary,
  CanonicalLocationSummary,
  CanonicalActivitySummary,
  CanonicalDashboardView,
  CanonicalRAGRecord,
  CanonicalRAGRecordMetadata,
  CompressionGroup,
  RawVsCanonicalComparison,
} from './types.dashboard';
export { buildIntegratedTruthBundle } from './buildIntegratedTruthBundle';
export type { BuildIntegratedTruthBundleOptions } from './buildIntegratedTruthBundle';
export { buildDashboardReadModel } from './buildDashboardReadModel';
export type { BuildDashboardReadModelOptions } from './buildDashboardReadModel';
export { buildRawOperatorSummary } from './buildRawOperatorSummary';
export type { RawOperatorSummary } from './buildRawOperatorSummary';
export { buildRawLocationSummary } from './buildRawLocationSummary';
export type { RawLocationSummary } from './buildRawLocationSummary';
export { buildRawActivitySummary } from './buildRawActivitySummary';
export type { RawActivitySummary } from './buildRawActivitySummary';
export { buildRawDashboardView } from './buildRawDashboardView';
export type {
  RawDashboardView,
  RawDashboardCounts,
  BuildRawDashboardViewOptions,
} from './buildRawDashboardView';
export { compareLegacyVsTruthDaySummary } from './compareLegacyVsTruthDaySummary';
export type {
  LegacyDaySummaryLike,
  LegacyVsTruthComparison,
  CompareLegacyVsTruthOptions,
} from './compareLegacyVsTruthDaySummary';
export {
  buildCanonicalOperatorIndex,
  getIdentityConfidence,
  getSourceIdentities,
  lookupCanonicalOperator,
} from './canonicalIdentity';
export type {
  CanonicalOperatorIndex,
  CanonicalOperatorIndexEntry,
  IdentityConfidence,
  SourceIdentities,
} from './canonicalIdentity';
export type { BuildRAGRecordsOptions } from './buildRAGRecords';
export { scoreOperatorIdentitySeverity } from './scoreOperatorIdentitySeverity';
export type {
  SeverityInputs,
  SeverityResult,
} from './scoreOperatorIdentitySeverity';
export { buildOperatorIdentityDiagnostics } from './buildOperatorIdentityDiagnostics';
export { buildIdentityHealthView } from './buildIdentityHealthView';
export type { BuildIdentityHealthViewOptions } from './buildIdentityHealthView';
export { buildIdentityHealthDashboardSummary } from './buildIdentityHealthDashboardSummary';
export type { BuildIdentityHealthDashboardSummaryOptions } from './buildIdentityHealthDashboardSummary';
export { buildIdentityHealthSnapshot } from './buildIdentityHealthSnapshot';
export type { BuildIdentityHealthSnapshotOptions } from './buildIdentityHealthSnapshot';
export type {
  OperatorIdentityDiagnostic,
  IdentityHealthSummary,
  IdentityIssueGroup,
  IdentityIssueKind,
  IdentityHealthView,
  IdentityHealthDashboardSummary,
  IdentityHealthSnapshot,
  IdentitySeverity,
  IdentityHeadlineStatus,
  TopRiskyOperator,
} from './types.identityHealth';
export {
  buildCanonicalLocationIndex,
  getLocationConfidence,
  getLocationSourceKinds,
  lookupCanonicalLocation,
} from './canonicalLocationIdentity';
export type {
  CanonicalLocationIndex,
  CanonicalLocationIndexEntry,
  LocationIdentityConfidence,
  LocationSourceKinds,
} from './canonicalLocationIdentity';
export { buildLocationIdentityDiagnostics } from './buildLocationIdentityDiagnostics';
export type { BuildLocationIdentityDiagnosticsOptions } from './buildLocationIdentityDiagnostics';
// Phase 18 — official SWD reference + normalization helper.
export { normalizeLocationNameForOfficialMatch } from './normalizeOfficialLocationName';
export {
  isOfficialSwd,
  getSwdReferenceNames,
  buildSwdReferenceSet,
} from './swdReference';
export type {
  SwdReferenceRuntimeEntry,
  BuildSwdReferenceSetOptions,
} from './swdReference';
export { SWD_REFERENCE } from './data/swdReference';
export type { SwdReferenceEntry } from './data/swdReference';
export { buildLocationHealthView } from './buildLocationHealthView';
export type { BuildLocationHealthViewOptions } from './buildLocationHealthView';
export { buildLocationHealthDashboardSummary } from './buildLocationHealthDashboardSummary';
export type { BuildLocationHealthDashboardSummaryOptions } from './buildLocationHealthDashboardSummary';
export type {
  LocationIdentityDiagnostic,
  LocationHealthSummary,
  LocationHealthView,
  LocationHealthDashboardSummary,
  TopAliasGroup,
  CustomOnlyLocationEntry,
  LocationTrustLevel,
  LocationTrustCounts,
  LocationConvergenceDisposition,
  LocationConvergenceCounts,
  LocationConvergencePreview,
  LocationConvergencePreviewCounts,
  LocationReviewDisposition,
  LocationReviewCounts,
  LocationEffectiveConvergence,
  LocationEffectiveConvergenceCounts,
  LocationManualApproval,
} from './types.locationHealth';
export {
  deriveLocationConvergenceDisposition,
  computeAliasDiversity,
  lightNormalizeAliasForDiversity,
} from './deriveLocationConvergenceDisposition';
export type {
  ConvergenceDispositionInput,
  ConvergenceDispositionResult,
} from './deriveLocationConvergenceDisposition';
export { deriveLocationConvergencePreview } from './deriveLocationConvergencePreview';
export type { LocationConvergencePreviewInput } from './deriveLocationConvergencePreview';
export { deriveLocationReviewDisposition } from './deriveLocationReviewDisposition';
export type {
  LocationReviewDispositionInput,
  LocationReviewDispositionResult,
} from './deriveLocationReviewDisposition';
export { deriveEffectiveLocationConvergence } from './deriveEffectiveLocationConvergence';
export type { EffectiveLocationConvergenceInput } from './deriveEffectiveLocationConvergence';
export { buildRAGIngestBundle } from './buildRAGIngestBundle';
export type { BuildRAGIngestBundleOptions } from './buildRAGIngestBundle';
export { buildShadowComparisonBundle } from './buildShadowComparisonBundle';
export type { BuildShadowComparisonBundleOptions } from './buildShadowComparisonBundle';
export type {
  IntegratedTruthBundle,
  DashboardReadModel,
  RAGIngestBundle,
  RAGIngestBundleStats,
  ShadowComparisonBundle,
} from './types.integration';
