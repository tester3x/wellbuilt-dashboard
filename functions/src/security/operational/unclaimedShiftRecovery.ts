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
  diagnosticSource: string | null;
  diagnosticResult: string | null;
  diagnosticReason: string | null;
  diagnosticApp: string | null;
  inspectionsPostTripMatching: number;
  reportsPostTripMatching: number;
  completionReadable: boolean;
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
  | { kind: 'minted_diagnostics'; periodId: string }
  | { kind: 'sync_post_trip_inspections'; companyId: string; periodId: string }
  | { kind: 'sync_dvir_reports'; companyId: string; periodId: string };

export interface RecoveryQueryResult {
  readable: boolean;
  error?: 'unreadable' | 'missing_index' | 'denied' | 'malformed';
  docs: DiagnosticDoc[];
  matchingCount: number;
}

export function credentialsPath(driverId: string): string {
  return `driver_credentials/${driverId}`;
}

function clientTimestampMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : null;
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

export function countPostTripMatches(
  result: CompletionQuery,
): { readable: boolean; matchingCount: number } {
  if (!result.readable) return { readable: false, matchingCount: 0 };
  return { readable: true, matchingCount: result.matchingCount };
}

export function snapshotFromEvidence(input: {
  request: UnclaimedRecoveryRequest;
  authority: ShiftAuthorityRecord | null;
  originDay: OriginDayEvidence;
  nameIndexDriverId: string | null;
  credentialsActive: boolean | null;
  diagnosticBound: UnclaimedInspectSnapshot['diagnosticBound'];
  diagnosticSample: Record<string, unknown> | null;
  inspections: CompletionQuery;
  reports: CompletionQuery;
}): UnclaimedInspectSnapshot {
  const originLocalDate = originDayOf(input.request.periodId) || '';
  const resolved = decideResolve(input.authority, {
    driverId: input.request.driverId,
    companyId: input.request.companyId,
  });
  const insp = countPostTripMatches(input.inspections);
  const reps = countPostTripMatches(input.reports);
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
    diagnosticSource: typeof input.diagnosticSample?.source === 'string' ? input.diagnosticSample.source : null,
    diagnosticResult: typeof input.diagnosticSample?.result === 'string' ? input.diagnosticSample.result : null,
    diagnosticReason: typeof input.diagnosticSample?.reason === 'string' ? input.diagnosticSample.reason : null,
    diagnosticApp: typeof input.diagnosticSample?.app === 'string' ? input.diagnosticSample.app : null,
    inspectionsPostTripMatching: insp.matchingCount,
    reportsPostTripMatching: reps.matchingCount,
    completionReadable: insp.readable && reps.readable,
  };
}

export function computeInspectFingerprint(
  snap: UnclaimedInspectSnapshot,
  sha256Hex: (s: string) => string,
): string {
  return sha256Hex(JSON.stringify({
    schema: 2,
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
    diagnosticSource: snap.diagnosticSource,
    diagnosticResult: snap.diagnosticResult,
    diagnosticReason: snap.diagnosticReason,
    diagnosticApp: snap.diagnosticApp,
    inspectionsPostTripMatching: snap.inspectionsPostTripMatching,
    reportsPostTripMatching: snap.reportsPostTripMatching,
    completionReadable: snap.completionReadable,
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
  if (!snap.completionReadable) return 'completion_unreadable';
  if (snap.inspectionsPostTripMatching > 0 || snap.reportsPostTripMatching > 0) return 'post_trip_exists';
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
    || snap.diagnosticApp !== INCIDENT.diagnostic.app) {
    return 'diagnostic_mismatch';
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
