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
 * The close event is written to the day it OCCURS on, matching WB-S
 * (shiftTracking.ts `const date = dateString(now)`); for a cross-midnight shift
 * that is a different document from the origin-day marker, so the transaction
 * spans up to three documents. Firestore transactions are multi-document, so
 * this is genuine atomicity, not a claimed equivalence.
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
  decideResolve,
  eventDayPath,
  isLocalDate,
  isPeriodId,
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
const CLOSE_KEYS = ['periodId'];

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
    // One server clock reading; the close DAY is derived from it, never from
    // the client, so a device with a wrong clock cannot file a close on the
    // wrong day document.
    const serverIsoNow = new Date().toISOString();
    const closeLocalDate = serverIsoNow.slice(0, 10);
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
      // '' is WB-S's established "explicitly closed" marker — distinct from an
      // absent field, which means never opened. Preserved deliberately.
      tx.set(db().doc(shiftDayPath(who.driverId, decision.originLocalDate)), {
        currentShiftId: '',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // The close event belongs to the day it OCCURS on, matching WB-S
      // (shiftTracking.ts: `const date = dateString(now)`). For a cross-midnight
      // shift that is a DIFFERENT document from the origin-day marker above —
      // which is exactly why both must commit in one transaction. Mike's
      // 2026-08-08 shift is the live proof of the split: its origin day still
      // names it open while a later day carries an unrelated logout.
      tx.set(db().doc(eventDayPath(who.driverId, closeLocalDate)), {
        driverId: who.driverId,
        companyId: who.companyId,
        date: closeLocalDate,
        updatedAt: FieldValue.serverTimestamp(),
        events: FieldValue.arrayUnion(
          buildLifecycleEvent('logout', decision.periodId, serverIsoNow),
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
      state: 'none' as const,
      closedPeriodId: outcome.periodId,
      alreadyClosed: outcome.action === 'already_closed',
    };
  },
);
