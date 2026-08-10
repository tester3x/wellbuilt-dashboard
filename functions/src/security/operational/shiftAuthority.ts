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
 * Is a client-proposed local date physically possible right now?
 *
 * The device owns the local calendar — no company timezone exists for
 * explicit_shift (see SHIFT-EVENT-SEMANTICS.md), so the claim's
 * `originLocalDate` is the ONLY local-calendar input the system ever gets.
 * That makes it worth bounding: real UTC offsets span UTC-12..UTC+14, so a
 * genuine local date can differ from the server's UTC date by at most one
 * day in either direction.
 *
 * This does NOT detect a device that is a few hours off — nothing can, from a
 * date alone. It rejects the failures that matter: a wildly wrong clock, a
 * typo'd year, and a replayed claim for an old day. Anything it accepts is
 * then frozen in the authority record and reused for the whole period, so the
 * date is decided ONCE rather than re-derived per event.
 */
export function isPlausibleLocalDate(localDate: string, serverIsoNow: string): boolean {
  if (!isLocalDate(localDate)) return false;
  const claimed = Date.parse(`${localDate}T00:00:00Z`);
  const serverDay = Date.parse(`${serverIsoNow.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(claimed) || !Number.isFinite(serverDay)) return false;
  const dayMs = 86400000;
  return Math.abs(claimed - serverDay) <= dayMs;
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
  /**
   * Set on close so a repeated close is idempotent rather than a mismatch.
   *
   * SINGLE SLOT — a stated limitation, not an oversight. It holds exactly the
   * MOST RECENTLY closed period. Closing period B overwrites A, after which a
   * delayed retry of A's close no longer matches and is refused with
   * `no_open_period` rather than answering `already_closed`.
   *
   * That is the safe direction to fail: the retry is refused, no shift is
   * ended, and the caller sees an explicit precondition failure instead of a
   * false success. It does mean idempotency is guaranteed only until the NEXT
   * close, so this record is not a close history and must never be read as
   * one — `driver_shifts` events remain the durable history.
   *
   * Widening this to a bounded ring of recent periods is possible, but it is
   * not implemented and no caller may assume it.
   */
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

/**
 * The authoritative lifecycle event appended by claim/close.
 *
 * PERIOD ATTRIBUTION IS NEW AND NECESSARY. The existing event elements carry
 * type/timestamp/lat/lng/source/displayName/driverHash and NO shift id, so an
 * event cannot be attributed to a period from the event alone. Without
 * `shiftId` the invariant "exactly one authoritative close for period X" is
 * unprovable. The field is purely additive: every existing reader keys off
 * `type`, so nothing breaks by its presence.
 *
 * `timestamp` is an ISO string from the SERVER clock, not a sentinel:
 * Firestore rejects serverTimestamp() inside array elements, and the
 * established event protocol is already an ISO string.
 */
export type ServerEventType = "login" | "logout" | "depart_return";

/**
 * The ONLY event types a server callable may author. An operational callable
 * takes no type from the caller — it is fixed per endpoint — so this list is
 * the whole authorable surface. There is deliberately no "write any event"
 * path.
 */
export const SERVER_AUTHORABLE_EVENT_TYPES: readonly ServerEventType[] =
  Object.freeze(["login", "logout", "depart_return"]);

export interface ShiftLifecycleEvent {
  type: ServerEventType;
  timestamp: string;
  shiftId: string;
  source: string;
}

export function buildLifecycleEvent(
  type: ServerEventType,
  shiftId: string,
  serverIsoNow: string,
): ShiftLifecycleEvent {
  return { type, timestamp: serverIsoNow, shiftId, source: "server" };
}

export type OperationalDecision =
  | { action: "append"; periodId: string; originLocalDate: string }
  /** This period already has this event. A repeated tap must not duplicate. */
  | { action: "already_recorded"; periodId: string }
  | { action: "refuse"; reason: OperationalRefusal };

export type OperationalRefusal =
  | ResolveUnverifiableReason
  | "invalid_period_id"
  | "no_open_period"
  | "period_mismatch";

/**
 * Decide an operational (non-lifecycle) event append.
 *
 * The rule that makes this safe: an operational event may ONLY be written
 * against the period the authority record currently reports OPEN, and the
 * caller must name that exact period. It therefore cannot open a shift
 * (`none` refuses), cannot close one (it never touches the pointer), and
 * cannot reach a period that is not this driver's current one.
 *
 * `alreadyPresent` is computed by the adapter from the day document: an event
 * of this type already carrying this `shiftId`. That is what makes a repeated
 * tap or an offline retry a no-op — array append alone would duplicate,
 * because each attempt carries a fresh server timestamp.
 */
export function decideOperationalEvent(
  record: ShiftAuthorityRecord | null,
  requestedPeriodId: string,
  expect: { driverId: string; companyId: string },
  alreadyPresent: boolean,
): OperationalDecision {
  if (!isPeriodId(requestedPeriodId)) {
    return { action: "refuse", reason: "invalid_period_id" };
  }
  const resolved = decideResolve(record, expect);
  if (resolved.state === "unverifiable") {
    return { action: "refuse", reason: resolved.reason };
  }
  // No open period: an operational event must never bring one into being.
  if (resolved.state === "none") {
    return { action: "refuse", reason: "no_open_period" };
  }
  if (resolved.periodId !== requestedPeriodId) {
    return { action: "refuse", reason: "period_mismatch" };
  }
  if (alreadyPresent) {
    return { action: "already_recorded", periodId: resolved.periodId };
  }
  return {
    action: "append",
    periodId: resolved.periodId,
    originLocalDate: resolved.originLocalDate,
  };
}

/** Odometer is TOTAL MILES FOR THE SHIFT (end − start), not a reading. */
export const ODOMETER_MAX_MILES = 5000;

/**
 * Bound the odometer value.
 *
 * WB-S computes `end − start` in the arrival modal and sends the difference,
 * so a legitimate value is a single shift's driving. The ceiling rejects an
 * absolute odometer reading pasted in by mistake (six figures), which would
 * otherwise silently become the day's `driveMiles` in every summary.
 */
export function isValidOdometerMiles(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v)
    && v >= 0 && v <= ODOMETER_MAX_MILES;
}

/**
 * THE canonical placement for every server-authored shift event: the
 * PERIOD'S ORIGIN DAY.
 *
 * WHY NOT THE DAY THE EVENT OCCURS ON. Filing by occurrence requires knowing
 * the driver's local calendar date at that moment, and the server does not
 * know it. An earlier revision used `serverIsoNow.slice(0, 10)`, which is the
 * UTC date — for a 20:37 close in America/Chicago that is 01:37 the NEXT UTC
 * day, so an evening close was filed a day late. No company timezone exists
 * to fix it with: explicit_shift stores none by design, Liquid Gold's
 * configuration is `{mode:'explicit_shift'}` with no `timezone`, and inferring
 * one from `state: 'ND'` would be wrong on its face — North Dakota spans both
 * Central and Mountain time. A driver working temporarily in another zone
 * breaks a company-level zone anyway.
 *
 * ORIGIN DAY NEEDS NO TIMEZONE. It is decided ONCE, at claim, from the
 * device's own local calendar, validated for internal consistency
 * (`originDayOf(periodId) === originLocalDate`) and for physical plausibility
 * (`isPlausibleLocalDate`), then frozen in the authority record. Every later
 * event reads that stored value instead of re-deriving a date from a clock,
 * so an off-by-one-day defect has nowhere to enter.
 *
 * CONSEQUENCE, STATED PLAINLY. A cross-midnight period's whole lifecycle —
 * login, depart_return, logout — lands on ONE document, the origin day. The
 * close-day document gets nothing. That matches how WB-JSA already reads
 * shift state (`shiftStaleness.ts` reads the origin-day document and keys on
 * `currentShiftId`) and it keeps `daySummary`'s adjacency pairing intact,
 * since the paired events stay together. It does change which calendar day a
 * cross-midnight shift's events appear under — see SHIFT-EVENT-SEMANTICS.md.
 */
export function eventDayFor(record: { originLocalDate: string }): string {
  return record.originLocalDate;
}
/** The day document whose `currentShiftId` every consumer already reads. */
export function shiftDayPath(driverId: string, localDate: string): string {
  return `driver_shifts/${driverId}_${localDate}`;
}
