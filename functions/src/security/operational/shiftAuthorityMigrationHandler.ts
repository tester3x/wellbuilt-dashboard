/**
 * adminRetroCloseDriverShift — the targeted historical correction handler.
 *
 * Deliberately built on the SAME admin convention as every other protected
 * mutation: `requireAdmin(deps, auth)` (verified wellbuiltAdmin claim AND an
 * enabled platform_admins record), an `AdminDeps` transaction, and an audit
 * record created inside that transaction. A second authorization scheme for a
 * one-off migration would be a second thing to get wrong.
 *
 * NOT a driver operation. Drivers cannot reach this; the shift callables have
 * no admin path. The two authorities stay separate.
 *
 * NO SCAN. There is no "find all stale markers" mode. The caller names one
 * driver and one period and states the evidence they reviewed; the handler's
 * whole job is to REFUSE unless that evidence still holds at write time.
 * Historical events carry no `shiftId`, so nothing can safely infer which
 * origin-day shift a close-day logout belongs to — a human decides once, the
 * server verifies rather than guesses. An inferring migration would close live
 * shifts.
 *
 * DRY BY DEFAULT: `dryRun` omitted means dry. A write must be asked for.
 */

import { AdminCallError, type AdminDeps, type AdminTransaction } from '../../admin/adminDeps';
import { requireAdmin } from '../../admin/adminHandlers';
import { ADMIN_AUDIT_COLLECTION, buildAuditRecord } from '../../admin/adminAudit';
import type { VerifiedCallerAuth } from '../../admin/authority';
import { shiftAuthorityPath, shiftDayPath, type ShiftAuthorityRecord } from './shiftAuthority';
import {
  decideRetroClose,
  describeRetroClose,
  type MigrationDayEvidence,
  type RetroCloseDecision,
} from './shiftAuthorityMigration';

const KEYS = ['driverId', 'companyId', 'periodId', 'originLocalDate', 'closeLocalDate'];

export interface RetroCloseResult {
  dryRun: boolean;
  classification: string;
  willWrite: string[];
  changed: boolean;
}

function requireStringField(d: Record<string, unknown>, k: string): string {
  const v = d[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > 200 || v.includes('/')) {
    throw new AdminCallError('invalid-argument', `invalid_field:${k}`);
  }
  return v;
}

function toDayEvidence(snap: { exists: boolean; data?: Record<string, unknown> }): MigrationDayEvidence {
  if (!snap.exists) return { readable: true, present: false, eventTypes: [] };
  const d = snap.data ?? {};
  const events = Array.isArray(d.events) ? d.events : [];
  return {
    readable: true,
    present: true,
    ...(typeof d.currentShiftId === 'string' ? { currentShiftId: d.currentShiftId } : {}),
    eventTypes: events
      .map((e) => (e && typeof e === 'object' ? (e as { type?: unknown }).type : undefined))
      .filter((t): t is string => typeof t === 'string'),
  };
}

/**
 * Parse an authority record. A document that fails to parse returns null, i.e.
 * UNVERIFIABLE — never a clean "none". Same rule as the driver callables.
 */
export function readAuthorityRecord(
  snap: { exists: boolean; data?: Record<string, unknown> },
): ShiftAuthorityRecord | null {
  if (!snap.exists) return null;
  const d = snap.data ?? {};
  if (typeof d.driverId !== 'string' || typeof d.companyId !== 'string'
      || typeof d.initialized !== 'boolean' || typeof d.version !== 'number') {
    return null;
  }
  return {
    driverId: d.driverId,
    companyId: d.companyId,
    initialized: d.initialized,
    openPeriodId: typeof d.openPeriodId === 'string' ? d.openPeriodId : null,
    originLocalDate: typeof d.originLocalDate === 'string' ? d.originLocalDate : null,
    lastClosedPeriodId: typeof d.lastClosedPeriodId === 'string' ? d.lastClosedPeriodId : null,
    version: d.version,
  };
}

async function classify(
  read: (path: string) => Promise<{ exists: boolean; data?: Record<string, unknown> }>,
  req: { driverId: string; companyId: string; periodId: string; originLocalDate: string; closeLocalDate: string },
): Promise<{ decision: RetroCloseDecision; authority: ShiftAuthorityRecord | null }> {
  // Sequential, not parallel: AdminTransaction models Firestore's rule that
  // every read precedes every write, and the mock enforces ordering.
  const authoritySnap = await read(shiftAuthorityPath(req.driverId));
  const originSnap = await read(shiftDayPath(req.driverId, req.originLocalDate));
  const closeSnap = await read(shiftDayPath(req.driverId, req.closeLocalDate));
  const authority = readAuthorityRecord(authoritySnap);
  return {
    authority,
    decision: decideRetroClose({
      request: req,
      originDay: toDayEvidence(originSnap),
      closeDay: toDayEvidence(closeSnap),
      authority,
    }),
  };
}

export async function retroCloseDriverShiftHandler(
  deps: AdminDeps,
  auth: VerifiedCallerAuth | null,
  data: unknown,
  opts: { dryRun: boolean },
): Promise<RetroCloseResult> {
  const actor = await requireAdmin(deps, auth);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AdminCallError('invalid-argument', 'payload_not_object');
  }
  const d = data as Record<string, unknown>;
  const unknownKeys = Object.keys(d).filter((k) => !KEYS.includes(k));
  if (unknownKeys.length) {
    throw new AdminCallError('invalid-argument', `unknown_fields:${unknownKeys.join(',')}`);
  }
  const req = {
    driverId: requireStringField(d, 'driverId'),
    companyId: requireStringField(d, 'companyId'),
    periodId: requireStringField(d, 'periodId'),
    originLocalDate: requireStringField(d, 'originLocalDate'),
    closeLocalDate: requireStringField(d, 'closeLocalDate'),
  };

  // Dry run reads and classifies OUTSIDE any transaction and writes nothing.
  if (opts.dryRun) {
    const { decision } = await classify((p) => deps.getDoc(p), req);
    return { dryRun: true, ...describeRetroClose(decision), changed: false };
  }

  const outcome = await deps.runTransaction(async (tx: AdminTransaction) => {
    // Every precondition is RE-READ here, so the decision cannot act on
    // evidence that changed between the dry run and the execution.
    const { decision, authority } = await classify((p) => tx.get(p), req);
    if (decision.action !== 'migrate') return decision;

    // Clear ONLY the stale marker. A field-merge naming exactly one key:
    // events, timestamps and every unrelated field survive untouched, and no
    // synthetic logout is appended — the authoritative close already exists on
    // the close day and is what this correction relies on.
    tx.update(shiftDayPath(req.driverId, decision.clearOriginMarkerAt), {
      currentShiftId: '',
      updatedAt: deps.serverTimestamp(),
    });

    const authorityFields = {
      driverId: req.driverId,
      companyId: req.companyId,
      initialized: true,
      openPeriodId: null,
      originLocalDate: null,
      lastClosedPeriodId: decision.initializeAuthority.lastClosedPeriodId,
      updatedAt: deps.serverTimestamp(),
    };
    // create-vs-update mirrors what the transaction actually read, so a
    // concurrently created authority document aborts rather than being
    // silently overwritten.
    if (authority === null) {
      tx.create(shiftAuthorityPath(req.driverId), { ...authorityFields, version: 1 });
    } else {
      tx.update(shiftAuthorityPath(req.driverId), { ...authorityFields, version: authority.version + 1 });
    }

    // Audit inside the same transaction — the correction and its audit trail
    // cannot exist without each other. Allowlisted nonsecret fields only.
    tx.create(
      `${ADMIN_AUDIT_COLLECTION}/${deps.newAuditId()}`,
      buildAuditRecord({
        operation: 'driverShift.retroCloseStaleOriginMarker',
        targetType: 'driver_shift',
        targetId: req.driverId,
        actorUid: actor.actorUid,
        actorEmail: actor.actorEmail,
        reason: `retro_close:${req.periodId}`,
        changedFields: ['driver_shifts.currentShiftId', 'driver_shift_authority'],
      }, deps.serverTimestamp()),
    );
    return decision;
  });

  if (outcome.action === 'refuse') {
    throw new AdminCallError('failed-precondition', `retro_close_refused:${outcome.reason}`);
  }
  return {
    dryRun: false,
    ...describeRetroClose(outcome),
    changed: outcome.action === 'migrate',
  };
}

/** Bound handlers for the two callables. Dry-run is a separate function name
 *  rather than a request flag, so "execute" can never be reached by a payload
 *  typo — the caller must invoke a differently-named endpoint. */
export const retroCloseDryRunHandler = (deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown) =>
  retroCloseDriverShiftHandler(deps, auth, data, { dryRun: true });
export const retroCloseExecuteHandler = (deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown) =>
  retroCloseDriverShiftHandler(deps, auth, data, { dryRun: false });
