/**
 * @tester3x/wellbuilt-contracts — curated public API.
 *
 * Exports are named explicitly (never `export *`) so the published surface
 * is a deliberate decision and an API-snapshot test can pin it. Internal
 * timezone/clock implementation details (zoneOffsetMinutes,
 * zonedWallTimeToUtcMs) stay module-private: consumers must not build
 * their own period math on them — that is exactly the drift this package
 * exists to prevent.
 *
 * Conformance fixtures are NOT here. They live behind
 * `@tester3x/wellbuilt-contracts/conformance` so production bundles never ship
 * test data.
 */
export { CONTRACT_VERSION } from './types.js';
export type { ContractVersion } from './types.js';
export { assertContractCompatible, SUPPORTED_CONTRACT_VERSIONS } from './handshake.js';
export type { PlanCapability, PlanDefinition, EntitlementOverride, CompanyEntitlement, EffectiveCompanyCapabilities, } from './types.js';
export type { WorkPeriodMode, CompanyWorkPeriodConfiguration, OperationalAction } from './types.js';
export { requiresWorkPeriod } from './types.js';
export type { DayShiftDoc, ExplicitShiftEvidence, ResolveInput, ResolutionSource, ResolvedPeriodBase, OpenPeriodResolution, WorkPeriodResolution, } from './types.js';
export { isOperationallyOpen, mayBindRequestEvidence } from './types.js';
export { resolveWorkPeriod, isValidTimezone, localDateInZone } from './resolver.js';
export type { ShiftScopedRecordKind, ShiftScopedBinding, BindingRejection } from './types.js';
export { bindShiftScopedRecord, verifyShiftScopedBinding } from './types.js';
export { DVIR_PROTOCOL_VERSION, SUPPORTED_DVIR_PROTOCOL_VERSIONS, assertDvirProtocolCompatible, isDvirProtocolDowngrade, DVIR_PHASES, isDvirPhase, recordKindForPhase, phaseForRecordKind, DVIR_REQUEST_STATUSES, isDvirRequestStatus, isLegalDvirRequestTransition, isDvirRequestConsumable, DVIR_ITEM_RESULTS, isDvirItemResult, DVIR_ITEM_RESULT_MEANING, DVIR_ISSUE_SEVERITIES, isDvirIssueSeverity, DVIR_ASSET_ROLES, DVIR_ATTESTATION_KINDS, DVIR_COMPLETION_OUTCOMES, DVIR_LEGACY_CATEGORY_IDS, isDvirLegacyCategoryId, DVIR_BOUNDS, normalizeDvirExplanation, isBoundedId, isBoundedLabel, isIsoTimestamp, containsBinaryPayload, } from './dvir/protocol.js';
export type { DvirProtocolVersion, DvirPhase, DvirRequestStatus, DvirItemResult, DvirIssueSeverity, DvirAssetRole, DvirAttestationKind, DvirCompletionOutcome, DvirLegacyCategoryId, } from './dvir/protocol.js';
export { DVIR_EVIDENCE_KEYS, DVIR_EVIDENCE_REQUIRED_KEYS, DVIR_EVIDENCE_ASSET_KEYS, DVIR_EVIDENCE_AREA_KEYS, DVIR_EVIDENCE_ITEM_KEYS, DVIR_EVIDENCE_ISSUE_KEYS, DVIR_EVIDENCE_ATTESTATION_KEYS, validateDvirNormalizedEvidence, computeLegacyCategoryProjection, canonicalDvirEvidenceString, } from './dvir/evidence.js';
export type { DvirNormalizedEvidence, DvirEvidenceArea, DvirEvidenceItem, DvirEvidenceIssue, DvirEvidenceAsset, DvirEvidenceAttestation, DvirLegacyCategoryProjection, DvirEvidenceRejection, DvirEvidenceResult, } from './dvir/evidence.js';
export { DVIR_REQUEST_KEYS, DVIR_COMPLETION_SUBMISSION_KEYS, DVIR_COMPLETION_RECORD_KEYS, DVIR_COMPLETION_VIEW_KEYS, DVIR_VIEW_FORBIDDEN_KEYS, DVIR_REQUEST_ID_PATTERN, isDvirRequestId, DVIR_COMPLETION_ID_PATTERN, isDvirCompletionId, validateDvirCompletionSubmission, toDvirCompletionView, viewMatchesRecord, isEquivalentDvirCompletion, satisfiesEnforcedDvirPhase, } from './dvir/records.js';
export type { DvirRequest, DvirCompletionSubmission, DvirCompletionRecord, DvirCompletionView, DvirSubmissionRejection, DvirSubmissionResult, } from './dvir/records.js';
export { DVIR_MISSING_EVIDENCE_KINDS, DVIR_MISSING_EVIDENCE_OUTCOME, DVIR_MISSING_EVIDENCE_KEYS, DVIR_MISSING_EVIDENCE_RECORD_KEYS, DVIR_MISSING_EVIDENCE_LABEL, validateDvirMissingEvidenceSubmission, missingEvidenceSatisfiesEnforcedPhase, isDvirMissingEvidenceSubmission, } from './dvir/missingEvidence.js';
export type { DvirMissingEvidenceKind, DvirMissingEvidenceOutcome, DvirMissingEvidenceSubmission, DvirMissingEvidenceRecord, DvirMissingEvidenceRejection, DvirMissingEvidenceResult, } from './dvir/missingEvidence.js';
//# sourceMappingURL=index.d.ts.map