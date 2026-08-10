/**
 * Explicit-shift authority callables: resolve / claim / close.
 *
 * Thin adapters over the pure decisions in shiftAuthority.ts. The security
 * value is that identity comes from the verified Auth context and the DECISION
 * happens inside the transaction that writes — so the read that authorizes and
 * the write that acts cannot be separated by another device's commit.
 *
 * ONE TRANSACTION CARRIES THE WHOLE INVARIANT: the authority pointer, the day
 * document's `currentShiftId`, and the authoritative login/logout EVENT. An
 * earlier revision left the event to WB-S, which splits the invariant — server
 * clears the pointer, client dies before appending the logout, and the system
 * then permits a new shift while the history has no authoritative close. Since
 * sign-in/out timestamps are the product's authority, pointer-null alone is not
 * a close.
 *
 * EVERY server-authored event goes to the PERIOD'S ORIGIN DAY. An earlier
 * revision filed the close on the day it occurred, computed as
 * `serverIsoNow.slice(0,10)` — a UTC date. An evening close in America/Chicago
 * (20:37 local = 01:37 UTC next day) was therefore filed a day late, which is
 * the same cross-midnight inconsistency this module exists to remove. No
 * company timezone exists to compute a real local date with, so the fix is to
 * stop deriving a date at all: the origin day is decided once at claim and
 * read back from the authority record. See eventDayFor().
 *
 * Events gain `shiftId`. The existing elements carry no period attribution at
 * all, so "exactly one authoritative close for period X" was unprovable. The
 * field is additive — every current reader keys off `type`.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
  type CanonicalDriverRecordReaders,
} from '../canonicalDriverAuthority';
import {
  buildLifecycleEvent,
  decideClaim,
  decideClose,
  decideOperationalEvent,
  decideResolve,
  isLocalDate,
  isPeriodId,
  isPlausibleLocalDate,
  isValidOdometerMiles,
  recordAfterClaim,
  recordAfterClose,
  shiftAuthorityPath,
  shiftDayPath,
  type ShiftAuthorityRecord,
} from './shiftAuthority';

export const SHIFT_AUTHORITY_OPTIONS = {
  timeoutSeconds: 15,
  memory: '256MiB' as const,
  enforceAppCheck: false,
};

/** Exact accepted keys per callable. Anything else is a protocol violation. */
const RESOLVE_KEYS: string[] = [];
const CLAIM_KEYS = ['periodId', 'originLocalDate'];
/** `odometerMiles` is OPTIONAL: total miles for the shift, captured in the
 *  arrival modal that already drives the close. Folding it in keeps the
 *  odometer and the authoritative logout atomic — they describe the same
 *  moment, and two separate unauthenticated writes is what we are replacing. */
const CLOSE_KEYS = ['periodId', 'odometerMiles'];
const DEPART_RETURN_KEYS = ['periodId'];

function requireExactKeys(data: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new httpsV2.HttpsError('invalid-argument', 'payload_not_object');
  }
  const extra = Object.keys(data as Record<string, unknown>).filter((k) => !allowed.includes(k));
  if (extra.length) {
    // Named so a client sending driverId/companyId learns the field does not
    // exist rather than believing it was honoured.
    throw new httpsV2.HttpsError('invalid-argument', `unknown_fields:${extra.join(',')}`);
  }
  return data as Record<string, unknown>;
}

/**
 * The subject is ALWAYS the authenticated driver. There is no driverId or
 * companyId input on any of these callables, so there is nothing to point at
 * another tenant — cross-driver access is structurally impossible rather than
 * checked.
 */
export async function resolveSubject(
  request: httpsV2.CallableRequest<unknown>,
  readers: CanonicalDriverRecordReaders = productionCanonicalDriverReaders(),
): Promise<{ driverId: string; companyId: string }> {
  const auth = request.auth;
  if (!auth?.uid || auth.token?.kind !== 'driver' || typeof auth.token?.driverId !== 'string') {
    throw new httpsV2.HttpsError('unauthenticated', 'driver_session_required');
  }
  // The CLAIM asserts which driver is calling; it is not evidence of that
  // driver's liveness or company. Both come from authoritative records.
  const authority = await loadCanonicalDriverAuthority(auth.token.driverId, readers);
  if (!authority) {
    throw new httpsV2.HttpsError('permission-denied', 'driver_not_authoritative');
  }
  if (!authority.active) {
    throw new httpsV2.HttpsError('permission-denied', 'driver_inactive');
  }
  // A stale companyId in a long-lived token is RECONCILED, not trusted: the
  // profile's company wins. A driver moved between companies therefore acts
  // under the new one, and the authority record written under the old company
  // no longer matches — decideResolve returns driver_mismatch and every
  // mutation fails closed rather than crossing a tenant boundary.
  return { driverId: authority.driverId, companyId: authority.companyId };
}

function readRecord(data: Record<string, unknown> | undefined): ShiftAuthorityRecord | null {
  if (!data) return null;
  const { driverId, companyId, initialized, openPeriodId, originLocalDate, version } = data;
  if (typeof driverId !== 'string' || typeof companyId !== 'string'
      || typeof initialized !== 'boolean' || typeof version !== 'number') {
    return null;
  }
  return {
    driverId,
    companyId,
    initialized,
    openPeriodId: typeof openPeriodId === 'string' ? openPeriodId : null,
    originLocalDate: typeof originLocalDate === 'string' ? originLocalDate : null,
    lastClosedPeriodId: typeof data.lastClosedPeriodId === 'string' ? data.lastClosedPeriodId : null,
    version,
  };
}

const db = () => admin.firestore();

// ── resolve ───────────────────────────────────────────────────────────────

export const resolveActiveDriverShift = httpsV2.onCall(
  SHIFT_AUTHORITY_OPTIONS,
  async (request) => {
    requireExactKeys(request.data ?? {}, RESOLVE_KEYS);
    const who = await resolveSubject(request);
    const snap = await db().doc(shiftAuthorityPath(who.driverId)).get();
    const result = decideResolve(snap.exists ? readRecord(snap.data()) : null, who);
    // Side-effect free by construction: resolve NEVER writes, so a login or a
    // cold-start check cannot mint a shift.
    return { ...result, protocolVersion: 1 as const };
  },
);

// ── claim ─────────────────────────────────────────────────────────────────

export const claimDriverShift = httpsV2.onCall(
  SHIFT_AUTHORITY_OPTIONS,
  async (request) => {
    const d = requireExactKeys(request.data ?? {}, CLAIM_KEYS);
    const who = await resolveSubject(request);
    const periodId = d.periodId;
    const originLocalDate = d.originLocalDate;
    if (!isPeriodId(periodId) || !isLocalDate(originLocalDate)) {
      throw new httpsV2.HttpsError('invalid-argument', 'malformed_period');
    }

    const authorityRef = db().doc(shiftAuthorityPath(who.driverId));
    // One server clock reading drives the whole transaction.
    const serverIsoNow = new Date().toISOString();
    // The device owns the local calendar, but not without a bound. This is
    // the ONE place a client date enters the system; once accepted it is
    // frozen in the authority record and reused for every event of the
    // period, so a bad value here would misfile the whole shift.
    if (!isPlausibleLocalDate(originLocalDate, serverIsoNow)) {
      throw new httpsV2.HttpsError('invalid-argument', 'implausible_origin_local_date');
    }

    const outcome = await db().runTransaction(async (tx) => {
      const snap = await tx.get(authorityRef);
      const record = snap.exists ? readRecord(snap.data()) : null;
      const decision = decideClaim(record, { periodId, originLocalDate }, who);

      if (decision.action === 'refuse') return decision;
      if (decision.action === 'existing') return decision;

      // The pointer and the day document move together. A reader that trusts
      // currentShiftId and a reader that trusts the pointer must never be able
      // to observe different answers.
      tx.set(authorityRef, {
        ...recordAfterClaim(record as ShiftAuthorityRecord, decision.periodId, decision.originLocalDate),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // Pointer, day marker AND the authoritative start event commit together.
      // The event is period-attributed, so "exactly one start for this period"
      // is provable rather than inferred from array position.
      tx.set(db().doc(shiftDayPath(who.driverId, decision.originLocalDate)), {
        currentShiftId: decision.periodId,
        driverId: who.driverId,
        companyId: who.companyId,
        date: decision.originLocalDate,
        updatedAt: FieldValue.serverTimestamp(),
        events: FieldValue.arrayUnion(
          buildLifecycleEvent('login', decision.periodId, serverIsoNow),
        ),
      }, { merge: true });
      return decision;
    });

    if (outcome.action === 'refuse') {
      throw new httpsV2.HttpsError(
        outcome.reason.startsWith('invalid') || outcome.reason === 'period_date_mismatch'
          ? 'invalid-argument'
          : 'failed-precondition',
        outcome.reason,
      );
    }
    return {
      protocolVersion: 1 as const,
      state: 'open' as const,
      periodId: outcome.periodId,
      originLocalDate: outcome.originLocalDate,
      claimed: outcome.action === 'claim',
    };
  },
);

// ── close ─────────────────────────────────────────────────────────────────

export const closeDriverShift = httpsV2.onCall(
  SHIFT_AUTHORITY_OPTIONS,
  async (request) => {
    const d = requireExactKeys(request.data ?? {}, CLOSE_KEYS);
    const who = await resolveSubject(request);
    if (!isPeriodId(d.periodId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'malformed_period');
    }
    const requestedPeriodId = d.periodId as string;
    if (d.odometerMiles !== undefined && !isValidOdometerMiles(d.odometerMiles)) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_odometer_miles');
    }
    const odometerMiles = d.odometerMiles as number | undefined;
    // One server clock reading. NOTE: the close DAY is no longer derived from
    // it. `serverIsoNow.slice(0,10)` is a UTC date, and an evening close in
    // America/Chicago falls on the NEXT UTC day — a 20:37 close became 01:37
    // tomorrow and was filed a day late. The event now goes to the period's
    // stored origin day, which needs no timezone at all.
    const serverIsoNow = new Date().toISOString();
    const authorityRef = db().doc(shiftAuthorityPath(who.driverId));

    const outcome = await db().runTransaction(async (tx) => {
      const snap = await tx.get(authorityRef);
      const record = snap.exists ? readRecord(snap.data()) : null;
      const decision = decideClose(record, requestedPeriodId, who);
      if (decision.action !== 'close') return decision;

      tx.set(authorityRef, {
        ...recordAfterClose(record as ShiftAuthorityRecord, decision.periodId),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // ONE document now carries the whole close: the marker, the
      // authoritative logout, and the shift's odometer. '' is WB-S's
      // established "explicitly closed" marker — distinct from an absent
      // field, which means never opened. Preserved deliberately.
      //
      // The event goes to the PERIOD'S ORIGIN DAY, not the day the close
      // happens to fall on, because the origin day is already known from the
      // authority record and requires no timezone to compute. See
      // eventDayFor() for why occurrence-day placement is unfixable here.
      tx.set(db().doc(shiftDayPath(who.driverId, decision.originLocalDate)), {
        currentShiftId: '',
        updatedAt: FieldValue.serverTimestamp(),
        events: FieldValue.arrayUnion(
          buildLifecycleEvent('logout', decision.periodId, serverIsoNow),
        ),
        // Total miles for THIS shift, so it belongs on the period's document
        // alongside the close it was captured with.
        ...(odometerMiles !== undefined ? { odometerMiles } : {}),
      }, { merge: true });
      return decision;
    });

    if (outcome.action === 'refuse') {
      throw new httpsV2.HttpsError(
        outcome.reason === 'invalid_period_id' ? 'invalid-argument' : 'failed-precondition',
        outcome.reason,
      );
    }
    return {
      protocolVersion: 1 as const,
      state: 'none' as const,
      closedPeriodId: outcome.periodId,
      alreadyClosed: outcome.action === 'already_closed',
    };
  },
);

// ── operational events ────────────────────────────────────────────────────

/**
 * recordDepartReturn — the driver has started the drive back to the yard.
 *
 * NARROW BY CONSTRUCTION. The event type is fixed by the endpoint, not taken
 * from the caller, so this is not a "write any event" door. It appends
 * exactly one `depart_return` and touches nothing else: it cannot open a
 * period (an absent or closed pointer refuses), cannot close one (the pointer
 * is never written), and cannot reach another driver or company (the subject
 * comes from canonical authority, and there is no id input).
 *
 * ORDERING IS PRESERVED, NOT ENFORCED. depart_return must precede Post-Trip
 * and close in the product flow; the server does not police that order, it
 * only guarantees the event is attributed to the open period. Close remains
 * a separate authenticated call the client makes after Post-Trip.
 */
export const recordDepartReturn = httpsV2.onCall(
  SHIFT_AUTHORITY_OPTIONS,
  async (request) => {
    const d = requireExactKeys(request.data ?? {}, DEPART_RETURN_KEYS);
    const who = await resolveSubject(request);
    if (!isPeriodId(d.periodId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'malformed_period');
    }
    const requestedPeriodId = d.periodId as string;
    const serverIsoNow = new Date().toISOString();
    const authorityRef = db().doc(shiftAuthorityPath(who.driverId));

    const outcome = await db().runTransaction(async (tx) => {
      const snap = await tx.get(authorityRef);
      const record = snap.exists ? readRecord(snap.data()) : null;

      // Resolve first WITHOUT the day document: until the period is known
      // there is no origin day to read, and reading the wrong one would be
      // its own defect.
      const probe = decideResolve(record, who);
      if (probe.state !== 'open' || probe.periodId !== requestedPeriodId) {
        return decideOperationalEvent(record, requestedPeriodId, who, false);
      }

      // Idempotency needs the CURRENT events: a bare append would duplicate
      // on a repeated tap, because each attempt carries a fresh timestamp and
      // arrayUnion only dedupes byte-identical elements.
      const dayRef = db().doc(shiftDayPath(who.driverId, probe.originLocalDate));
      const daySnap = await tx.get(dayRef);
      const events = daySnap.exists && Array.isArray(daySnap.data()?.events)
        ? (daySnap.data()!.events as unknown[])
        : [];
      const alreadyPresent = events.some((e) => {
        if (!e || typeof e !== 'object') return false;
        const ev = e as { type?: unknown; shiftId?: unknown };
        return ev.type === 'depart_return' && ev.shiftId === requestedPeriodId;
      });

      const decision = decideOperationalEvent(record, requestedPeriodId, who, alreadyPresent);
      if (decision.action !== 'append') return decision;

      // Same canonical placement as login/logout: the period's origin day.
      tx.set(dayRef, {
        driverId: who.driverId,
        companyId: who.companyId,
        date: decision.originLocalDate,
        updatedAt: FieldValue.serverTimestamp(),
        events: FieldValue.arrayUnion(
          buildLifecycleEvent('depart_return', decision.periodId, serverIsoNow),
        ),
      }, { merge: true });
      return decision;
    });

    if (outcome.action === 'refuse') {
      throw new httpsV2.HttpsError(
        outcome.reason === 'invalid_period_id' ? 'invalid-argument' : 'failed-precondition',
        outcome.reason,
      );
    }
    return {
      protocolVersion: 1 as const,
      periodId: outcome.periodId,
      recorded: outcome.action === 'append',
    };
  },
);
