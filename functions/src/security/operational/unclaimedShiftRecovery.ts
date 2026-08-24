/**
 * Incident-bound admin recovery of Mikezfold's unclaimed local period
 * 2026-08-21_112421 (Liquid Gold).
 *
 * Public `writeDiagnosticLog` MAY omit driverHash. The reviewed mint
 * diagnostic for this incident has no driverHash, so it is NOT identity.
 * Identity is independently resolved from:
 *   driver_name_index/mikezfold → driverId
 *   driver_credentials/{driverId} (active)
 *   driver_shift_authority.driverId / companyId
 *   request.companyId === liquid-gold
 *
 * The diagnostic is shape/time corroboration of the reviewed mint only.
 * A diagnostic with another driver's hash, wrong shape, or a different
 * period is refused. Ordinary claimDriverShift is untouched.
 *
 * COMPLETION AUTHORITY (source-audited, not invented):
 * WB-E SHA 994ddcee FirebaseDvirTransport writes DvirCloudDocument to
 * organizations/{orgId}/dvirReports on named app "dvir"
 * (wellbuilt-equipment-prod / wellbuilt-equipment-dev). Schema is
 * summary.inspectionType + report.shiftId — summary has no shiftId.
 * Production cloud writes are hard-disabled (dvirCloudGate:
 * isDvirCloudWritesEnabled() false unless development + flag +
 * wellbuilt-equipment-dev; wellbuilt-equipment-prod always false;
 * DVIR_CLOUD_WRITES_ENABLED = false). Therefore this historical
 * incident has NO server-authoritative Post-Trip store. Device-local
 * completion (LocalCompletedReportStore) is not a server store.
 * wellbuilt-sync organizations/{id}/dvirReports is NOT the WB-E store.
 * Dashboard dvir.submitPreTrip is pre_trip only.
 *
 * A dedicated-project read cannot join a wellbuilt-sync transaction.
 * Absence of a Post-Trip server document therefore cannot be proven
 * atomically. Execute refuses.
 *
 * PURE. No firebase-admin, no I/O.
 */
import {
  decideResolve,
  isPeriodId,
  originDayOf,
  type ShiftAuthorityRecord,
} from './shiftAuthority.js';

export const RECOVER_UNCLAIMED_OPERATION = 'driverShift.recoverUnclaimedLocalPeriod';
export const AUTHORITY_RECOVERED_EVENT_TYPE = 'authority_recovered' as const;

/** Reviewed incident. This callable refuses any other period/company/name. */
export const INCIDENT = Object.freeze({
  periodId: '2026-08-21_112421',
  originLocalDate: '2026-08-21',
  companyId: 'liquid-gold',
  displayNameNorm: 'mikezfold',
  lastClosedPeriodId: '2026-08-17_004824',
  diagnostic: Object.freeze({
    app: 'wbs',
    area: 'shift',
    event: 'shiftId.minted',
    result: 'ok',
    reason: 'legacy path local mint',
    source: 'AuthContext.startShift',
    clientTimestampMinMs: Date.parse('2026-08-21T16:24:21.000Z'),
    clientTimestampMaxMs: Date.parse('2026-08-21T16:24:23.000Z'),
  }),
});

/**
 * Exact WB-E writer this incident is judged against.
 * Fold7-approved source SHA (994ddcee). Not a live production read.
 */
export const WB_E_COMPLETION_AUTHORITY = Object.freeze({
  writerSha: '994ddcee146194874bd8fa1b97b4990eb3193831',
  writerTransport: 'FirebaseDvirTransport.upsertReport',
  writerDocumentBuilder: 'buildCloudDocument',
  namedApp: 'dvir' as const,
  dedicatedProject: Object.freeze({
    prod: 'wellbuilt-equipment-prod',
    dev: 'wellbuilt-equipment-dev',
  }),
  forbiddenHostProject: 'wellbuilt-sync',
  collectionSegments: Object.freeze(['organizations', '{orgId}', 'dvirReports'] as const),
  query: Object.freeze({
    inspectionTypeField: 'summary.inspectionType' as const,
    inspectionTypeValue: 'post_trip' as const,
    shiftIdField: 'report.shiftId' as const,
  }),
  /** dvirCloudGate: production and wellbuilt-equipment-prod never write. */
  productionCloudWritesEnabled: false as const,
  productionAuthoritativeServerStore: false as const,
  productionCompletion: 'device_local' as const,
  crossProjectAtomicExclusion: false as const,
});

export type RecoverMode = 'inspect' | 'execute';

export interface UnclaimedRecoveryRequest {
  driverId: string;
  companyId: string;
  periodId: string;
  expectedAuthorityVersion: number;
  mode: RecoverMode;
  reason: string;
  inspectStateFingerprint: string;
}

export interface OriginDayEvidence {
  readable: boolean;
  present: boolean;
  currentShiftId?: string | null;
}

export interface DiagnosticDoc {
  id: string;
  data: Record<string, unknown>;
}

export interface CompletionQuery {
  readable: boolean;
  error?: 'unreadable' | 'missing_index' | 'denied' | 'malformed';
  matchingCount: number;
}

/** Redacted diagnostic tuple actually used for the decision. No driverHash. */
export interface RedactedDiagnosticTuple {
  id: string;
  app: string | null;
  area: string | null;
  event: string | null;
  result: string | null;
  reason: string | null;
  source: string | null;
  shiftId: string | null;
  clientTimestamp: string | null;
}

export interface UnclaimedInspectSnapshot {
  driverId: string;
  companyId: string;
  periodId: string;
  originLocalDate: string;
  expectedAuthorityVersion: number;
  initialized: boolean;
  authorityState: 'none' | 'open' | 'unverifiable';
  openPeriodId: string | null;
  authorityOriginLocalDate: string | null;
  lastClosedPeriodId: string | null;
  authorityVersion: number | null;
  originDayPresent: boolean;
  originDayCurrentShiftId: string | null;
  originDayReadable: boolean;
  identityMatch: boolean;
  nameIndexMatch: boolean;
  credentialsActive: boolean;
  diagnosticBound: 'incident_shape' | 'subject_bound' | 'anonymous' | 'foreign' | 'mismatch' | 'absent' | 'unreadable';
  diagnosticMatchingCount: number;
  diagnosticTuples: RedactedDiagnosticTuple[];
  diagnosticSource: string | null;
  diagnosticResult: string | null;
  diagnosticReason: string | null;
  diagnosticApp: string | null;
  diagnosticArea: string | null;
  diagnosticEvent: string | null;
  diagnosticShiftId: string | null;
  diagnosticClientTimestamp: string | null;
  completionStoreKind: 'none_authoritative_server';
  writerSha: string;
  dedicatedProjectProd: string;
  productionCloudWritesEnabled: false;
  productionAuthoritativeServerStore: false;
  productionCompletion: 'device_local';
  crossProjectAtomicExclusion: false;
}

export type UnclaimedRefusal =
  | 'invalid_request'
  | 'not_incident_period'
  | 'not_incident_company'
  | 'malformed_period'
  | 'period_date_mismatch'
  | 'authority_unreadable'
  | 'authority_not_initialized_none'
  | 'version_mismatch'
  | 'fingerprint_mismatch'
  | 'last_closed_match'
  | 'different_open_period'
  | 'origin_day_unreadable'
  | 'origin_day_conflict'
  | 'post_trip_exists'
  | 'completion_unreadable'
  | 'no_authoritative_server_completion_store'
  | 'insufficient_evidence'
  | 'identity_mismatch'
  | 'anonymous_diagnostic'
  | 'foreign_diagnostic'
  | 'diagnostic_mismatch'
  | 'already_recovered';

export type UnclaimedDecision =
  | { action: 'inspect'; fingerprint: string; recoverable: true }
  | { action: 'inspect'; fingerprint: string; recoverable: false; reason: UnclaimedRefusal }
  | { action: 'execute' }
  | { action: 'already_recovered' }
  | { action: 'refuse'; reason: UnclaimedRefusal };

export function buildAuthorityRecoveredEvent(
  shiftId: string,
  serverIsoNow: string,
): {
  type: typeof AUTHORITY_RECOVERED_EVENT_TYPE;
  timestamp: string;
  shiftId: string;
  source: 'admin_recover_unclaimed';
  recoveredFrom: 'unclaimed_local_state';
} {
  return {
    type: AUTHORITY_RECOVERED_EVENT_TYPE,
    timestamp: serverIsoNow,
    shiftId,
    source: 'admin_recover_unclaimed',
    recoveredFrom: 'unclaimed_local_state',
  };
}

export function recoveryAuditDocId(periodId: string, driverFp12: string): string {
  return `unclaimed_shift_${periodId}_${driverFp12}`;
}

export function nameIndexPath(displayNameNorm: string): string {
  return `driver_name_index/${displayNameNorm}`;
}

export type RecoveryQuerySpec =
  | { kind: 'minted_diagnostics'; periodId: string };

export interface RecoveryQueryResult {
  readable: boolean;
  error?: 'unreadable' | 'missing_index' | 'denied' | 'malformed';
  docs: DiagnosticDoc[];
  matchingCount: number;
}

export function credentialsPath(driverId: string): string {
  return `driver_credentials/${driverId}`;
}

export interface DedicatedPostTripQuerySpec {
  projectId: typeof WB_E_COMPLETION_AUTHORITY.dedicatedProject.prod;
  forbiddenProjectId: typeof WB_E_COMPLETION_AUTHORITY.forbiddenHostProject;
  namedApp: typeof WB_E_COMPLETION_AUTHORITY.namedApp;
  collectionPath: string;
  filters: ReadonlyArray<{
    field: typeof WB_E_COMPLETION_AUTHORITY.query.inspectionTypeField
      | typeof WB_E_COMPLETION_AUTHORITY.query.shiftIdField;
    op: '==';
    value: string;
  }>;
}

/**
 * Query the dedicated equipment project would use IF a server store existed.
 * Not used as execute proof: production has no authoritative store, and a
 * dedicated-project read cannot join a wellbuilt-sync transaction.
 */
export function dedicatedEquipmentPostTripQuerySpec(
  orgId: string,
  periodId: string,
): DedicatedPostTripQuerySpec {
  return {
    projectId: WB_E_COMPLETION_AUTHORITY.dedicatedProject.prod,
    forbiddenProjectId: WB_E_COMPLETION_AUTHORITY.forbiddenHostProject,
    namedApp: WB_E_COMPLETION_AUTHORITY.namedApp,
    collectionPath: `organizations/${orgId}/dvirReports`,
    filters: [
      {
        field: WB_E_COMPLETION_AUTHORITY.query.inspectionTypeField,
        op: '==',
        value: WB_E_COMPLETION_AUTHORITY.query.inspectionTypeValue,
      },
      {
        field: WB_E_COMPLETION_AUTHORITY.query.shiftIdField,
        op: '==',
        value: periodId,
      },
    ],
  };
}

/**
 * Match the FirebaseDvirTransport / buildCloudDocument schema only.
 * Top-level inspectionType/shiftId and summary.shiftId are NOT the writer.
 */
export function dedicatedPostTripDocumentMatches(
  data: Record<string, unknown>,
  periodId: string,
): boolean {
  const summary = data.summary;
  const report = data.report;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  const type = (summary as Record<string, unknown>).inspectionType;
  const shift = (report as Record<string, unknown>).shiftId;
  return type === 'post_trip' && shift === periodId;
}

function clientTimestampMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : null;
}

function asString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Exact reviewed WBS mint shape (not identity). */
export function diagnosticMatchesIncidentShape(data: Record<string, unknown>, periodId: string): boolean {
  const d = INCIDENT.diagnostic;
  if (data.app !== d.app) return false;
  if (data.area !== d.area) return false;
  if (data.event !== d.event) return false;
  if (data.result !== d.result) return false;
  if (data.reason !== d.reason) return false;
  if (data.source !== d.source) return false;
  if (data.shiftId !== periodId) return false;
  const ts = clientTimestampMs(data.clientTimestamp);
  if (ts == null) return false;
  if (ts < d.clientTimestampMinMs || ts > d.clientTimestampMaxMs) return false;
  return true;
}

export function redactedDiagnosticTuples(
  docs: DiagnosticDoc[],
  periodId: string,
): RedactedDiagnosticTuple[] {
  return docs
    .filter((d) => diagnosticMatchesIncidentShape(d.data, periodId))
    .map((d) => ({
      id: d.id,
      app: asString(d.data.app),
      area: asString(d.data.area),
      event: asString(d.data.event),
      result: asString(d.data.result),
      reason: asString(d.data.reason),
      source: asString(d.data.source),
      shiftId: asString(d.data.shiftId),
      clientTimestamp: asString(d.data.clientTimestamp),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function classifyDiagnosticDocs(
  result: CompletionQuery & { docs?: DiagnosticDoc[] },
  periodId: string,
  requestDriverId: string,
  resolveHash: (hash: string) => string | null,
): UnclaimedInspectSnapshot['diagnosticBound'] {
  if (!result.readable) return 'unreadable';
  const docs = result.docs ?? [];
  const matching = docs.filter((d) => diagnosticMatchesIncidentShape(d.data, periodId));
  if (matching.length === 0) {
    if (docs.length === 0) return 'absent';
    return 'mismatch';
  }
  let sawAnonymous = false;
  let sawSubject = false;
  for (const d of matching) {
    const hash = d.data.driverHash;
    if (hash == null || hash === '') {
      sawAnonymous = true;
      continue;
    }
    if (typeof hash !== 'string') return 'foreign';
    const resolved = resolveHash(hash);
    if (!resolved) return 'foreign';
    if (resolved !== requestDriverId) return 'foreign';
    sawSubject = true;
  }
  if (sawSubject) return 'subject_bound';
  if (sawAnonymous) return 'anonymous';
  return 'mismatch';
}

export function snapshotFromEvidence(input: {
  request: UnclaimedRecoveryRequest;
  authority: ShiftAuthorityRecord | null;
  originDay: OriginDayEvidence;
  nameIndexDriverId: string | null;
  credentialsActive: boolean | null;
  diagnosticBound: UnclaimedInspectSnapshot['diagnosticBound'];
  diagnosticTuples: RedactedDiagnosticTuple[];
}): UnclaimedInspectSnapshot {
  const originLocalDate = originDayOf(input.request.periodId) || '';
  const resolved = decideResolve(input.authority, {
    driverId: input.request.driverId,
    companyId: input.request.companyId,
  });
  const tuples = [...input.diagnosticTuples].sort((a, b) => a.id.localeCompare(b.id));
  const selected = tuples[0] ?? null;
  return {
    driverId: input.request.driverId,
    companyId: input.request.companyId,
    periodId: input.request.periodId,
    originLocalDate,
    expectedAuthorityVersion: input.request.expectedAuthorityVersion,
    initialized: input.authority?.initialized === true,
    authorityState: resolved.state === 'open' ? 'open' : resolved.state === 'none' ? 'none' : 'unverifiable',
    openPeriodId: resolved.state === 'open' ? resolved.periodId : input.authority?.openPeriodId ?? null,
    authorityOriginLocalDate: resolved.state === 'open'
      ? resolved.originLocalDate
      : input.authority?.originLocalDate ?? null,
    lastClosedPeriodId: input.authority?.lastClosedPeriodId ?? null,
    authorityVersion: input.authority?.version ?? null,
    originDayPresent: input.originDay.present === true,
    originDayCurrentShiftId: input.originDay.present
      ? (typeof input.originDay.currentShiftId === 'string' ? input.originDay.currentShiftId : null)
      : null,
    originDayReadable: input.originDay.readable === true,
    identityMatch: !input.authority
      || (input.authority.driverId === input.request.driverId
        && input.authority.companyId === input.request.companyId),
    nameIndexMatch: input.nameIndexDriverId === input.request.driverId,
    credentialsActive: input.credentialsActive === true,
    diagnosticBound: input.diagnosticBound,
    diagnosticMatchingCount: tuples.length,
    diagnosticTuples: tuples,
    diagnosticSource: selected?.source ?? null,
    diagnosticResult: selected?.result ?? null,
    diagnosticReason: selected?.reason ?? null,
    diagnosticApp: selected?.app ?? null,
    diagnosticArea: selected?.area ?? null,
    diagnosticEvent: selected?.event ?? null,
    diagnosticShiftId: selected?.shiftId ?? null,
    diagnosticClientTimestamp: selected?.clientTimestamp ?? null,
    completionStoreKind: 'none_authoritative_server',
    writerSha: WB_E_COMPLETION_AUTHORITY.writerSha,
    dedicatedProjectProd: WB_E_COMPLETION_AUTHORITY.dedicatedProject.prod,
    productionCloudWritesEnabled: WB_E_COMPLETION_AUTHORITY.productionCloudWritesEnabled,
    productionAuthoritativeServerStore: WB_E_COMPLETION_AUTHORITY.productionAuthoritativeServerStore,
    productionCompletion: WB_E_COMPLETION_AUTHORITY.productionCompletion,
    crossProjectAtomicExclusion: WB_E_COMPLETION_AUTHORITY.crossProjectAtomicExclusion,
  };
}

export function computeInspectFingerprint(
  snap: UnclaimedInspectSnapshot,
  sha256Hex: (s: string) => string,
): string {
  return sha256Hex(JSON.stringify({
    schema: 3,
    incident: INCIDENT.periodId,
    driverId: snap.driverId,
    companyId: snap.companyId,
    periodId: snap.periodId,
    originLocalDate: snap.originLocalDate,
    expectedAuthorityVersion: snap.expectedAuthorityVersion,
    initialized: snap.initialized,
    authorityState: snap.authorityState,
    openPeriodId: snap.openPeriodId,
    authorityOriginLocalDate: snap.authorityOriginLocalDate,
    lastClosedPeriodId: snap.lastClosedPeriodId,
    authorityVersion: snap.authorityVersion,
    originDayPresent: snap.originDayPresent,
    originDayCurrentShiftId: snap.originDayCurrentShiftId,
    identityMatch: snap.identityMatch,
    nameIndexMatch: snap.nameIndexMatch,
    credentialsActive: snap.credentialsActive,
    diagnosticBound: snap.diagnosticBound,
    diagnosticMatchingCount: snap.diagnosticMatchingCount,
    diagnosticTuples: snap.diagnosticTuples,
    diagnosticSource: snap.diagnosticSource,
    diagnosticResult: snap.diagnosticResult,
    diagnosticReason: snap.diagnosticReason,
    diagnosticApp: snap.diagnosticApp,
    diagnosticArea: snap.diagnosticArea,
    diagnosticEvent: snap.diagnosticEvent,
    diagnosticShiftId: snap.diagnosticShiftId,
    diagnosticClientTimestamp: snap.diagnosticClientTimestamp,
    completionStoreKind: snap.completionStoreKind,
    writerSha: snap.writerSha,
    dedicatedProjectProd: snap.dedicatedProjectProd,
    productionCloudWritesEnabled: snap.productionCloudWritesEnabled,
    productionAuthoritativeServerStore: snap.productionAuthoritativeServerStore,
    productionCompletion: snap.productionCompletion,
    crossProjectAtomicExclusion: snap.crossProjectAtomicExclusion,
  }));
}

function alreadyRecovered(snap: UnclaimedInspectSnapshot, periodId: string): boolean {
  return snap.authorityState === 'open'
    && snap.openPeriodId === periodId
    && snap.originDayPresent
    && snap.originDayCurrentShiftId === periodId;
}

function classifyRefusal(snap: UnclaimedInspectSnapshot, req: UnclaimedRecoveryRequest): UnclaimedRefusal | null {
  if (req.periodId !== INCIDENT.periodId) return 'not_incident_period';
  if (req.companyId !== INCIDENT.companyId) return 'not_incident_company';
  if (!isPeriodId(req.periodId)) return 'malformed_period';
  const origin = originDayOf(req.periodId);
  if (!origin || origin !== INCIDENT.originLocalDate || origin !== snap.originLocalDate) {
    return 'period_date_mismatch';
  }
  if (!snap.nameIndexMatch || !snap.credentialsActive || !snap.identityMatch) return 'identity_mismatch';
  if (!snap.originDayReadable) return 'origin_day_unreadable';
  if (snap.authorityState === 'unverifiable' || snap.authorityVersion == null) return 'authority_unreadable';
  if (alreadyRecovered(snap, req.periodId)) return null;
  if (snap.lastClosedPeriodId === req.periodId) return 'last_closed_match';
  if (snap.authorityState === 'open' && snap.openPeriodId !== req.periodId) return 'different_open_period';
  if (snap.originDayPresent) {
    const marker = snap.originDayCurrentShiftId;
    if (marker && marker !== req.periodId) return 'origin_day_conflict';
    if (marker === '') return 'origin_day_conflict';
    if (marker && marker === req.periodId && snap.authorityState !== 'open') return 'origin_day_conflict';
  }
  if (!(snap.initialized && snap.authorityState === 'none')) return 'authority_not_initialized_none';
  if (snap.authorityVersion !== req.expectedAuthorityVersion) return 'version_mismatch';
  if (snap.diagnosticBound === 'unreadable') return 'insufficient_evidence';
  if (snap.diagnosticBound === 'absent') return 'insufficient_evidence';
  if (snap.diagnosticBound === 'mismatch') return 'diagnostic_mismatch';
  if (snap.diagnosticBound === 'foreign') return 'foreign_diagnostic';
  if (snap.diagnosticBound === 'anonymous') {
    // Reviewed incident mint has no driverHash. Identity is name-index +
    // credentials + authority, not this public diagnostic. Any other
    // anonymous document is already 'mismatch' via shape/time.
    if (req.periodId !== INCIDENT.periodId) return 'anonymous_diagnostic';
  }
  if (snap.diagnosticBound !== 'incident_shape' && snap.diagnosticBound !== 'subject_bound'
    && snap.diagnosticBound !== 'anonymous') {
    return 'insufficient_evidence';
  }
  if (snap.diagnosticSource !== INCIDENT.diagnostic.source
    || snap.diagnosticResult !== INCIDENT.diagnostic.result
    || snap.diagnosticReason !== INCIDENT.diagnostic.reason
    || snap.diagnosticApp !== INCIDENT.diagnostic.app
    || snap.diagnosticArea !== INCIDENT.diagnostic.area
    || snap.diagnosticEvent !== INCIDENT.diagnostic.event
    || snap.diagnosticShiftId !== INCIDENT.periodId) {
    return 'diagnostic_mismatch';
  }
  const ts = clientTimestampMs(snap.diagnosticClientTimestamp);
  if (ts == null
    || ts < INCIDENT.diagnostic.clientTimestampMinMs
    || ts > INCIDENT.diagnostic.clientTimestampMaxMs) {
    return 'diagnostic_mismatch';
  }
  // Production WB-E has no server-authoritative Post-Trip store. A
  // dedicated-project read cannot join this wellbuilt-sync transaction.
  // Absence of completion cannot be proven; execute must refuse.
  if (WB_E_COMPLETION_AUTHORITY.productionAuthoritativeServerStore === false
    || snap.productionAuthoritativeServerStore === false
    || snap.completionStoreKind === 'none_authoritative_server') {
    return 'no_authoritative_server_completion_store';
  }
  return null;
}

export function decideUnclaimedRecovery(input: {
  request: UnclaimedRecoveryRequest;
  snapshot: UnclaimedInspectSnapshot;
  fingerprint: string;
}): UnclaimedDecision {
  const { request: req, snapshot: snap, fingerprint } = input;
  if (alreadyRecovered(snap, req.periodId)) {
    if (req.mode === 'inspect') {
      return { action: 'inspect', fingerprint, recoverable: false, reason: 'already_recovered' };
    }
    return { action: 'already_recovered' };
  }
  const refusal = classifyRefusal(snap, req);
  if (req.mode === 'inspect') {
    if (refusal) return { action: 'inspect', fingerprint, recoverable: false, reason: refusal };
    return { action: 'inspect', fingerprint, recoverable: true };
  }
  if (refusal) return { action: 'refuse', reason: refusal };
  if (!req.inspectStateFingerprint || req.inspectStateFingerprint !== fingerprint) {
    return { action: 'refuse', reason: 'fingerprint_mismatch' };
  }
  return { action: 'execute' };
}
