/**
 * Admin recovery of one unclaimed local explicit-shift period.
 *
 * THE DEFECT. Enforced explicit_shift requires claimDriverShift to author
 * driver_shift_authority. A legacy local-mint branch (AuthContext.startShift
 * reason "legacy path local mint") wrote only device state. The period
 * 2026-08-21_112421 exists in Suite and in wb_diagnostics, but the
 * date-free pointer stayed initialized-none (lastClosed 2026-08-17_004824)
 * and the origin-day document was never created.
 *
 * THIS IS NOT claimDriverShift. Ordinary claim still enforces
 * isPlausibleLocalDate, so drivers cannot claim arbitrary historical
 * periods. Recovery is platform-admin only, inspect-then-execute, and
 * names one reviewed period.
 *
 * PURE. No firebase-admin, no I/O. The handler supplies evidence.
 */
import {
  decideResolve,
  isPeriodId,
  originDayOf,
  type ShiftAuthorityRecord,
} from './shiftAuthority.js';

export const RECOVER_UNCLAIMED_OPERATION = 'driverShift.recoverUnclaimedLocalPeriod';
export const AUTHORITY_RECOVERED_EVENT_TYPE = 'authority_recovered' as const;

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

export interface MintedDiagnosticEvidence {
  found: boolean;
  reason: string | null;
  source: string | null;
}

export interface UnclaimedInspectSnapshot {
  periodId: string;
  originLocalDate: string;
  initialized: boolean;
  authorityState: 'none' | 'open' | 'unverifiable';
  openPeriodId: string | null;
  authorityOriginLocalDate: string | null;
  lastClosedPeriodId: string | null;
  authorityVersion: number | null;
  originDayPresent: boolean;
  originDayCurrentShiftId: string | null;
  originDayReadable: boolean;
  postTripPresent: boolean;
  mintedFound: boolean;
  mintedLegacyLocal: boolean;
  identityMatch: boolean;
}

export type UnclaimedRefusal =
  | 'invalid_request'
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
  | 'insufficient_evidence'
  | 'identity_mismatch'
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

export function snapshotFromEvidence(input: {
  request: UnclaimedRecoveryRequest;
  authority: ShiftAuthorityRecord | null;
  originDay: OriginDayEvidence;
  postTripPresent: boolean;
  minted: MintedDiagnosticEvidence;
}): UnclaimedInspectSnapshot {
  const originLocalDate = originDayOf(input.request.periodId) || '';
  const resolved = decideResolve(input.authority, {
    driverId: input.request.driverId,
    companyId: input.request.companyId,
  });
  const mintedLegacyLocal = !!(
    input.minted.found
    && typeof input.minted.reason === 'string'
    && /legacy path local mint/i.test(input.minted.reason)
  );
  return {
    periodId: input.request.periodId,
    originLocalDate,
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
    postTripPresent: input.postTripPresent,
    mintedFound: input.minted.found === true,
    mintedLegacyLocal,
    identityMatch: !input.authority
      || (input.authority.driverId === input.request.driverId
        && input.authority.companyId === input.request.companyId),
  };
}

export function computeInspectFingerprint(
  snap: UnclaimedInspectSnapshot,
  sha256Hex: (s: string) => string,
): string {
  return sha256Hex(JSON.stringify({
    schema: 1,
    periodId: snap.periodId,
    originLocalDate: snap.originLocalDate,
    initialized: snap.initialized,
    authorityState: snap.authorityState,
    openPeriodId: snap.openPeriodId,
    lastClosedPeriodId: snap.lastClosedPeriodId,
    authorityVersion: snap.authorityVersion,
    originDayPresent: snap.originDayPresent,
    originDayCurrentShiftId: snap.originDayCurrentShiftId,
    postTripPresent: snap.postTripPresent,
    mintedFound: snap.mintedFound,
    mintedLegacyLocal: snap.mintedLegacyLocal,
    identityMatch: snap.identityMatch,
  }));
}

function alreadyRecovered(snap: UnclaimedInspectSnapshot, periodId: string): boolean {
  return snap.authorityState === 'open'
    && snap.openPeriodId === periodId
    && snap.originDayPresent
    && snap.originDayCurrentShiftId === periodId;
}

function classifyRefusal(snap: UnclaimedInspectSnapshot, req: UnclaimedRecoveryRequest): UnclaimedRefusal | null {
  if (!isPeriodId(req.periodId)) return 'malformed_period';
  const origin = originDayOf(req.periodId);
  if (!origin || origin !== snap.originLocalDate) return 'period_date_mismatch';
  if (!snap.identityMatch) return 'identity_mismatch';
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
  if (snap.postTripPresent) return 'post_trip_exists';
  if (!(snap.initialized && snap.authorityState === 'none')) return 'authority_not_initialized_none';
  if (snap.authorityVersion !== req.expectedAuthorityVersion) return 'version_mismatch';
  if (!snap.mintedFound || !snap.mintedLegacyLocal) return 'insufficient_evidence';
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
