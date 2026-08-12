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
// Versioning / compatibility
export { CONTRACT_VERSION } from './types.js';
export { assertContractCompatible, SUPPORTED_CONTRACT_VERSIONS } from './handshake.js';
export { requiresWorkPeriod } from './types.js';
export { isOperationallyOpen, mayBindRequestEvidence } from './types.js';
export { resolveWorkPeriod, isValidTimezone, localDateInZone } from './resolver.js';
export { bindShiftScopedRecord, verifyShiftScopedBinding } from './types.js';
// ── DVIR request/completion protocol (0.2.0, additive) ─────────────────────
// Independent DVIR_PROTOCOL_VERSION; every 0.1.0 export above is unchanged.
export { DVIR_PROTOCOL_VERSION, SUPPORTED_DVIR_PROTOCOL_VERSIONS, assertDvirProtocolCompatible, isDvirProtocolDowngrade, DVIR_PHASES, isDvirPhase, recordKindForPhase, phaseForRecordKind, DVIR_REQUEST_STATUSES, isDvirRequestStatus, isLegalDvirRequestTransition, isDvirRequestConsumable, DVIR_ITEM_RESULTS, isDvirItemResult, DVIR_ITEM_RESULT_MEANING, DVIR_ISSUE_SEVERITIES, isDvirIssueSeverity, DVIR_ASSET_ROLES, DVIR_ATTESTATION_KINDS, DVIR_COMPLETION_OUTCOMES, DVIR_LEGACY_CATEGORY_IDS, isDvirLegacyCategoryId, DVIR_BOUNDS, normalizeDvirExplanation, isBoundedId, isBoundedLabel, isIsoTimestamp, containsBinaryPayload, } from './dvir/protocol.js';
export { DVIR_EVIDENCE_KEYS, DVIR_EVIDENCE_REQUIRED_KEYS, DVIR_EVIDENCE_ASSET_KEYS, DVIR_EVIDENCE_AREA_KEYS, DVIR_EVIDENCE_ITEM_KEYS, DVIR_EVIDENCE_ISSUE_KEYS, DVIR_EVIDENCE_ATTESTATION_KEYS, validateDvirNormalizedEvidence, computeLegacyCategoryProjection, canonicalDvirEvidenceString, } from './dvir/evidence.js';
export { DVIR_REQUEST_KEYS, DVIR_COMPLETION_SUBMISSION_KEYS, DVIR_COMPLETION_RECORD_KEYS, DVIR_COMPLETION_VIEW_KEYS, DVIR_VIEW_FORBIDDEN_KEYS, DVIR_REQUEST_ID_PATTERN, isDvirRequestId, DVIR_COMPLETION_ID_PATTERN, isDvirCompletionId, validateDvirCompletionSubmission, toDvirCompletionView, viewMatchesRecord, isEquivalentDvirCompletion, satisfiesEnforcedDvirPhase, } from './dvir/records.js';
export { DVIR_MISSING_EVIDENCE_KINDS, DVIR_MISSING_EVIDENCE_OUTCOME, DVIR_MISSING_EVIDENCE_KEYS, DVIR_MISSING_EVIDENCE_RECORD_KEYS, DVIR_MISSING_EVIDENCE_LABEL, validateDvirMissingEvidenceSubmission, missingEvidenceSatisfiesEnforcedPhase, isDvirMissingEvidenceSubmission, } from './dvir/missingEvidence.js';
// ── WB-S → WB-T SSO authorization-code protocol (0.3.0-dev, additive) ─────
// Independent SSO_PROTOCOL_VERSION; every 0.1.0/0.2.0 export is unchanged.
export { SSO_PROTOCOL_VERSION, SUPPORTED_SSO_PROTOCOL_VERSIONS, assertSsoProtocolCompatible, isSsoProtocolVersion, SSO_AUDIENCE_WBT, SSO_AUDIENCES, isSsoAudience, SSO_SESSION_APP_CLAIM, SSO_SESSION_APP_WBT, SSO_CHALLENGE_METHOD, isSsoChallengeMethod, SSO_STATE_BYTES, SSO_VERIFIER_BYTES, SSO_CODE_BYTES, SSO_B64URL_32_LENGTH, SSO_STATE_PATTERN, SSO_CODE_PATTERN, SSO_CHALLENGE_PATTERN, SSO_VERIFIER_PATTERN, isSsoState, isSsoCode, isSsoChallenge, isSsoVerifier, SSO_AUTHORIZE_SCHEME, SSO_AUTHORIZE_HOST, SSO_CALLBACK_SCHEME, SSO_CALLBACK_HOST, SSO_ERROR_CODES, isSsoErrorCode, validateSsoAuthorizationRequest, validateSsoIssueCodeRequest, validateSsoExchangeRequest, validateSsoCallback, SSO_FORBIDDEN_DEEPLINK_KEYS, containsForbiddenSsoField, SSO_AUTHORIZATION_KEYS, SSO_CALLBACK_SUCCESS_KEYS, SSO_CALLBACK_ERROR_KEYS, hasOnlyKeys, buildSsoAuthorizationUrl, parseSsoAuthorizationUrl, buildSsoCallbackUrl, parseSsoCallbackUrl, SSO_CODE_TTL_MS_PROVISIONAL, SSO_ATTEMPT_TTL_MS_PROVISIONAL, 
// vc51.9AE — equipment audience (additive)
SSO_AUDIENCE_EQUIPMENT, SSO_SESSION_APP_EQUIPMENT, SSO_SESSION_APP_BY_AUDIENCE, SSO_CALLBACK_SCHEME_EQUIPMENT, SSO_CALLBACK_BY_AUDIENCE, isSsoShiftBinding, audienceRequiresShiftBinding, SSO_SHIFT_ID_MAX, 
// Authoritative display name on the tickets exchange response (additive)
SSO_DISPLAY_NAME_MAX, audienceCarriesDisplayName, normalizeSsoDisplayName, } from './sso/protocol.js';
// ── Optional session audience for driver auth (0.3.0-dev, additive) ───────
export { SESSION_AUDIENCE_WBT, SESSION_AUDIENCES, SESSION_APP_CLAIM, isSessionAudience, readSessionAudience, CLIENT_FORBIDDEN_CLAIM_KEYS, containsClientClaimMaterial, sessionClaimsForAudience, } from './auth/sessionAudience.js';
// ── Per-app commercial entitlement (0.3.0-dev, additive) ─────────────────
// Extends the effective-plan model with "is this app included, and does it
// require an active shift". Nothing above is changed; `PlanDefinition.apps`
// is optional and absent means today's behavior.
export { WELLBUILT_APP_TICKETS, WELLBUILT_APP_EQUIPMENT, WELLBUILT_APP_JSA, WELLBUILT_APP_MOBILE, WELLBUILT_APP_SUITE, WELLBUILT_APP_DASHBOARD, WELLBUILT_APP_KEYS, isWellbuiltAppKey, WELLBUILT_CORE_APPS, isCoreApp, WELLBUILT_APP_KEY_ALIASES, resolveWellbuiltAppKey, APP_ENTITLEMENT_KEYS, APP_CONFIGURATION_CONFLICT, resolveAppEntitlement, isAppEntitled, appRequiresActiveShift, decideAppAccess, reconcileAppConfiguration, validatePlanAppEntitlements, } from './plan/appEntitlement.js';
// ── Per-company operational app configuration (0.4.0-dev, additive) ───────
// The plan says what a company bought; this says how that company runs it.
// Narrowing only: it may disable an included app or ADD a shift
// requirement, never enable an excluded one or remove a plan-level gate.
// Every 0.3.0 export above is unchanged — `decideAppAccess` still answers
// from the plan alone and configuration awareness is opt-in.
export { COMPANY_APP_CONFIGURATION_KEYS, validateCompanyAppConfigurations, configurationRequiresActiveShift, configurationDisablesApp, decideAppAccessWithConfiguration, } from './plan/companyAppConfiguration.js';
//# sourceMappingURL=index.js.map