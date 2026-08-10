/**
 * Server-owned explicit-shift authority — the per-driver active-shift pointer.
 *
 * WHY THIS EXISTS. Liquid Gold runs enforced `explicit_shift`. After a clean
 * close and full logout WB-S clears its local `wellbuilt-current-shift-id`,
 * and there is no canonical server-side per-driver pointer, so a client with
 * no cache cannot prove whether an indefinitely old shift is still open. Both
 * restoration and pre-mint fail closed with `missing_cache_no_safe_discovery`,
 * and two devices can each mint a different "open" period because the mint is
 * client-local. A read-only pointer followed by a client mint keeps that race;
 * only a decisive server transaction removes it.
 *
 * THIS IS NOT HOS. Nothing here rate-limits, enforces rest, or delays a new
 * shift. A driver may claim a new period immediately after an authoritative
 * clean close.
 *
 * ABSENCE IS NOT "NONE". Production data predates this pointer, so a missing
 * or uninitialized record means UNVERIFIABLE, never "no open shift".
 * Collapsing those two would silently authorize a second concurrent period for
 * every pre-existing driver — the exact failure this record prevents. Only a
 * bounded, authenticated initialization may establish `none`.
 *
 * PURE. No firebase-admin, no clock, no I/O: every decision is a function of
 * the record and the request, so the concurrency and idempotency matrix runs
 * in-memory. The callable adapter supplies the transaction.
 */

/** `YYYY-MM-DD_HHMMSS` — WB-S's existing shift-id format, unchanged. */
export const PERIOD_ID_PATTERN = '^\\d{4}-\\d{2}-\\d{2}_\\d{6}$';
export const LOCAL_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export function isPeriodId(v: unknown): v is string {
  return typeof v === 'string' && new RegExp(PERIOD_ID_PATTERN).test(v);
}
export function isLocalDate(v: unknown): v is string {
  return typeof v === 'string' && new RegExp(LOCAL_DATE_PATTERN).test(v);
}

/** The origin day a period id names. Format is a hint; never authority. */
export function originDayOf(periodId: string): string | null {
  return isPeriodId(periodId) ? periodId.slice(0, 10) : null;
}

/**
 * The stored authority record. Server-owned: Firestore rules must deny all
 * client access, exactly as they already do for platform_admins.
 */
export interface ShiftAuthorityRecord {
  driverId: string;
  companyId: string;
  /**
   * True only once a bounded authenticated initialization has established
   * this driver's state. A record that exists without this is still
   * unverifiable — a half-written document must not read as "none".
   */
  initialized: boolean;
  openPeriodId: string | null;
  originLocalDate: string | null;
  /** Set on close so a repeated close is idempotent rather than a mismatch. */
  lastClosedPeriodId?: string | null;
  /** Monotonic; lets a caller detect it acted on a stale view. */
  version: number;
}

export type ResolveResult =
  | { state: 'open'; periodId: string; originLocalDate: string }
  | { state: 'none' }
  | { state: 'unverifiable'; reason: ResolveUnverifiableReason };

export type ResolveUnverifiableReason =
  | 'authority_absent'
  | 'authority_uninitialized'
  | 'authority_inconsistent'
  | 'driver_mismatch';

/**
 * Decide what the authority says. The ONLY path to `none` is an initialized
 * record with a null pointer.
 */
export function decideResolve(
  record: ShiftAuthorityRecord | null,
  expect: { driverId: string; companyId: string },
): ResolveResult {
  if (!record) return { state: 'unverifiable', reason: 'authority_absent' };
  if (record.driverId !== expect.driverId || record.companyId !== expect.companyId) {
    // A record for a different subject is never evidence about this one.
    return { state: 'unverifiable', reason: 'driver_mismatch' };
  }
  if (record.initialized !== true) {
    return { state: 'unverifiable', reason: 'authority_uninitialized' };
  }
  const hasPeriod = record.openPeriodId !== null && record.openPeriodId !== undefined;
  const hasDate = record.originLocalDate !== null && record.originLocalDate !== undefined;
  if (hasPeriod !== hasDate) {
    // Half a binding is not a binding. Refuse rather than guess the other half.
    return { state: 'unverifiable', reason: 'authority_inconsistent' };
  }
  if (!hasPeriod) return { state: 'none' };
  if (!isPeriodId(record.openPeriodId) || !isLocalDate(record.originLocalDate)
      || originDayOf(record.openPeriodId as string) !== record.originLocalDate) {
    return { state: 'unverifiable', reason: 'authority_inconsistent' };
  }
  return {
    state: 'open',
    periodId: record.openPeriodId as string,
    originLocalDate: record.originLocalDate as string,
  };
}

export type ClaimDecision =
  /** A period is already open. Return THAT binding; never mint a second. */
  | { action: 'existing'; periodId: string; originLocalDate: string }
  /** Safe to claim exactly this period. */
  | { action: 'claim'; periodId: string; originLocalDate: string }
  | { action: 'refuse'; reason: ClaimRefusal };

export type ClaimRefusal =
  | ResolveUnverifiableReason
  | 'invalid_period_id'
  | 'invalid_origin_local_date'
  | 'period_date_mismatch';

/**
 * Decide a claim.
 *
 * The CLIENT proposes the period id and its origin local date, because the
 * device owns the local calendar and explicit_shift stores no timezone the
 * server could use to derive one. The proposal is only a proposal: this
 * decision — evaluated inside the transaction — is what settles whether it is
 * taken. When a period is already open the proposal is discarded and the
 * existing binding is returned, so two devices racing produce one period and
 * both learn the same answer.
 */
export function decideClaim(
  record: ShiftAuthorityRecord | null,
  proposal: { periodId: string; originLocalDate: string },
  expect: { driverId: string; companyId: string },
): ClaimDecision {
  const resolved = decideResolve(record, expect);
  if (resolved.state === 'unverifiable') {
    return { action: 'refuse', reason: resolved.reason };
  }
  if (resolved.state === 'open') {
    return {
      action: 'existing',
      periodId: resolved.periodId,
      originLocalDate: resolved.originLocalDate,
    };
  }
  // Initialized as none — validate the proposal before taking it.
  if (!isPeriodId(proposal.periodId)) {
    return { action: 'refuse', reason: 'invalid_period_id' };
  }
  if (!isLocalDate(proposal.originLocalDate)) {
    return { action: 'refuse', reason: 'invalid_origin_local_date' };
  }
  if (originDayOf(proposal.periodId) !== proposal.originLocalDate) {
    // Internal consistency: a period id whose day disagrees with its stated
    // origin date would make every later origin-day lookup wrong.
    return { action: 'refuse', reason: 'period_date_mismatch' };
  }
  return {
    action: 'claim',
    periodId: proposal.periodId,
    originLocalDate: proposal.originLocalDate,
  };
}

export type CloseDecision =
  | { action: 'close'; periodId: string; originLocalDate: string }
  /** Already closed, and it was THIS period — safe repeat delivery. */
  | { action: 'already_closed'; periodId: string }
  | { action: 'refuse'; reason: CloseRefusal };

export type CloseRefusal =
  | ResolveUnverifiableReason
  | 'invalid_period_id'
  /** A different period is open. Closing it would end the wrong shift. */
  | 'period_mismatch'
  /** Initialized as none and this period is not the one last closed. */
  | 'no_open_period';

/**
 * Decide a close.
 *
 * The requested period must match the open pointer exactly. A stale or
 * mismatched request is refused WITHOUT touching the pointer — a retry from an
 * old device, or a delayed duplicate naming a previous period, must never end
 * the shift a driver is currently working.
 */
export function decideClose(
  record: ShiftAuthorityRecord | null,
  requestedPeriodId: string,
  expect: { driverId: string; companyId: string },
): CloseDecision {
  if (!isPeriodId(requestedPeriodId)) {
    return { action: 'refuse', reason: 'invalid_period_id' };
  }
  const resolved = decideResolve(record, expect);
  if (resolved.state === 'unverifiable') {
    return { action: 'refuse', reason: resolved.reason };
  }
  if (resolved.state === 'none') {
    // Idempotent ONLY when the same period is the one we already closed.
    if (record && record.lastClosedPeriodId === requestedPeriodId) {
      return { action: 'already_closed', periodId: requestedPeriodId };
    }
    return { action: 'refuse', reason: 'no_open_period' };
  }
  if (resolved.periodId !== requestedPeriodId) {
    return { action: 'refuse', reason: 'period_mismatch' };
  }
  return {
    action: 'close',
    periodId: resolved.periodId,
    originLocalDate: resolved.originLocalDate,
  };
}

/** The record a successful claim writes. */
export function recordAfterClaim(
  prev: ShiftAuthorityRecord,
  periodId: string,
  originLocalDate: string,
): ShiftAuthorityRecord {
  return {
    ...prev,
    openPeriodId: periodId,
    originLocalDate,
    version: prev.version + 1,
  };
}

/** The record a successful close writes. Pointer cleared, period remembered. */
export function recordAfterClose(
  prev: ShiftAuthorityRecord,
  periodId: string,
): ShiftAuthorityRecord {
  return {
    ...prev,
    openPeriodId: null,
    originLocalDate: null,
    lastClosedPeriodId: periodId,
    version: prev.version + 1,
  };
}

/** Where the authority lives. Server-owned; client access must be denied. */
export const SHIFT_AUTHORITY_COLLECTION = 'driver_shift_authority';

export function shiftAuthorityPath(driverId: string): string {
  return `${SHIFT_AUTHORITY_COLLECTION}/${driverId}`;
}

/** The day document whose `currentShiftId` every consumer already reads. */
export function shiftDayPath(driverId: string, localDate: string): string {
  return `driver_shifts/${driverId}_${localDate}`;
}
