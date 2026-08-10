/**
 * Targeted historical correction of a stale origin-day shift marker.
 *
 * THE SHAPE OF THE DEFECT. The old writer appended events to the document for
 * the calendar day each event OCCURRED on, and set `currentShiftId` on that
 * day's document. A cross-midnight shift therefore opened on its origin day
 * and closed on a later day — clearing the LATER document's marker and leaving
 * the origin day still naming the period as current. The canonical resolver
 * reads the origin day, so the period reads OPEN forever.
 *
 * Mike's `2026-08-08_211725` is exactly this: one ~23-hour shift, closed on
 * 2026-08-09, whose origin-day marker was never cleared.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not invent a logout timestamp,
 * does not touch historical events, and does not decide on its own that some
 * close-day logout belongs to some origin-day shift. Historical events carry
 * no `shiftId`, so that attribution CANNOT be inferred safely — the caller
 * must supply the reviewed evidence and this module verifies it still holds.
 * A migration that guessed would silently close live shifts.
 *
 * PURE: no firebase-admin, no clock, no I/O.
 */

import { isLocalDate, isPeriodId, type ShiftAuthorityRecord } from './shiftAuthority';
import { decideResolve } from './shiftAuthority';

/** One day document as read, reduced to what the decision needs. */
export interface MigrationDayEvidence {
  readable: boolean;
  present: boolean;
  currentShiftId?: string;
  /** Event types present, in order. Timestamps are not needed to decide. */
  eventTypes: string[];
}

/**
 * Caller-supplied, human-reviewed evidence. Every field is re-verified against
 * live documents before anything is written; supplying them is an assertion
 * the migration must confirm, never a shortcut it trusts.
 */
export interface RetroCloseRequest {
  driverId: string;
  companyId: string;
  periodId: string;
  originLocalDate: string;
  /** The day whose authoritative logout closed this period. */
  closeLocalDate: string;
}

export type RetroCloseRefusal =
  | 'invalid_request'
  | 'origin_unreadable'
  | 'origin_absent'
  | 'origin_marker_mismatch'
  | 'close_day_unreadable'
  | 'close_day_absent'
  | 'close_evidence_missing'
  | 'close_day_still_open'
  | 'authority_already_open'
  | 'period_date_mismatch';

export type RetroCloseDecision =
  | {
      action: 'migrate';
      /** Exactly what will be written. Nothing else is touched. */
      clearOriginMarkerAt: string;
      initializeAuthority: {
        initialized: true;
        openPeriodId: null;
        originLocalDate: null;
        lastClosedPeriodId: string;
      };
    }
  /** Already corrected — a repeat run is a no-op, not an error. */
  | { action: 'already_migrated'; reason: 'origin_marker_clear' | 'authority_initialized' }
  | { action: 'refuse'; reason: RetroCloseRefusal };

/**
 * Decide a targeted retro-close.
 *
 * Order matters: the cheapest structural checks first, then origin evidence,
 * then close evidence, and only then the authority record — so a refusal never
 * depends on a read that a previous check should have prevented.
 */
export function decideRetroClose(input: {
  request: RetroCloseRequest;
  originDay: MigrationDayEvidence;
  closeDay: MigrationDayEvidence;
  authority: ShiftAuthorityRecord | null;
}): RetroCloseDecision {
  const { request: r, originDay, closeDay, authority } = input;

  if (!isPeriodId(r.periodId) || !isLocalDate(r.originLocalDate) || !isLocalDate(r.closeLocalDate)
      || !r.driverId || !r.companyId) {
    return { action: 'refuse', reason: 'invalid_request' };
  }
  if (r.periodId.slice(0, 10) !== r.originLocalDate) {
    return { action: 'refuse', reason: 'period_date_mismatch' };
  }

  // Authority already established and OPEN — never retro-close a live period.
  if (authority) {
    const resolved = decideResolve(authority, { driverId: r.driverId, companyId: r.companyId });
    if (resolved.state === 'open') {
      return { action: 'refuse', reason: 'authority_already_open' };
    }
    if (resolved.state === 'none') {
      return { action: 'already_migrated', reason: 'authority_initialized' };
    }
    // unverifiable → fall through; this migration is what initializes it.
  }

  // An unreadable document is never evidence. Refuse rather than assume.
  if (!originDay.readable) return { action: 'refuse', reason: 'origin_unreadable' };
  if (!originDay.present) return { action: 'refuse', reason: 'origin_absent' };

  // Already cleared by a previous run (or by WB-S) — idempotent no-op.
  if (originDay.currentShiftId === '') {
    return { action: 'already_migrated', reason: 'origin_marker_clear' };
  }
  // The marker must still name EXACTLY the period under correction. If it
  // names another period, the world moved and the reviewed evidence is stale.
  if (originDay.currentShiftId !== r.periodId) {
    return { action: 'refuse', reason: 'origin_marker_mismatch' };
  }

  if (!closeDay.readable) return { action: 'refuse', reason: 'close_day_unreadable' };
  if (!closeDay.present) return { action: 'refuse', reason: 'close_day_absent' };
  // The authoritative close must already exist. This migration clears a stale
  // marker; it never manufactures the close it is relying on.
  if (!closeDay.eventTypes.includes('logout')) {
    return { action: 'refuse', reason: 'close_evidence_missing' };
  }
  // And that day must itself be closed — a close day still naming an open
  // period would mean the shift did not actually end there.
  if (closeDay.currentShiftId !== '') {
    return { action: 'refuse', reason: 'close_day_still_open' };
  }

  return {
    action: 'migrate',
    clearOriginMarkerAt: r.originLocalDate,
    initializeAuthority: {
      initialized: true,
      openPeriodId: null,
      originLocalDate: null,
      lastClosedPeriodId: r.periodId,
    },
  };
}

/** Nonsecret dry-run projection. Contains no events, timestamps, or identity. */
export function describeRetroClose(d: RetroCloseDecision): {
  classification: string;
  willWrite: string[];
} {
  if (d.action === 'refuse') return { classification: `refuse:${d.reason}`, willWrite: [] };
  if (d.action === 'already_migrated') {
    return { classification: `already_migrated:${d.reason}`, willWrite: [] };
  }
  return {
    classification: 'migrate:stale_origin_marker',
    willWrite: [
      `driver_shifts/{driverId}_${d.clearOriginMarkerAt}.currentShiftId = ""`,
      'driver_shift_authority/{driverId} = { initialized:true, openPeriodId:null, '
      + `originLocalDate:null, lastClosedPeriodId:"${d.initializeAuthority.lastClosedPeriodId}" }`,
    ],
  };
}
