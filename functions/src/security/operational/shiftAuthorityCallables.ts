/**
 * Explicit-shift authority callables: resolve / claim / close.
 *
 * Thin adapters over the pure decisions in shiftAuthority.ts. The security
 * value is that identity comes from the verified Auth context and the DECISION
 * happens inside the transaction that writes — so the read that authorizes and
 * the write that acts cannot be separated by another device's commit.
 *
 * Each callable writes BOTH the authority pointer and the day document's
 * `currentShiftId` in one transaction. `currentShiftId` is what every existing
 * consumer already reads (the canonical resolver, WB-S restoration, the DVIR
 * gate), so the pointer can never disagree with it. WB-S continues to append
 * its own `events[]`; that schema is untouched here.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  decideClaim,
  decideClose,
  decideResolve,
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
async function subject(request: httpsV2.CallableRequest<unknown>) {
  const driver = await requireSecureDriver(request, { allowLegacyHash: false });
  if (!driver.companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'company_binding_required');
  }
  return { driverId: driver.driverId, companyId: driver.companyId };
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
    const who = await subject(request);
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
    const who = await subject(request);
    const periodId = d.periodId;
    const originLocalDate = d.originLocalDate;
    if (!isPeriodId(periodId) || !isLocalDate(originLocalDate)) {
      throw new httpsV2.HttpsError('invalid-argument', 'malformed_period');
    }

    const authorityRef = db().doc(shiftAuthorityPath(who.driverId));

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
      tx.set(db().doc(shiftDayPath(who.driverId, decision.originLocalDate)), {
        currentShiftId: decision.periodId,
        driverId: who.driverId,
        companyId: who.companyId,
        updatedAt: FieldValue.serverTimestamp(),
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
    const who = await subject(request);
    if (!isPeriodId(d.periodId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'malformed_period');
    }
    const requestedPeriodId = d.periodId as string;
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
